use crate::model_catalog::{self, huggingface, installed, schema::Engine};
use crate::model_integrity::{self, Pinned};
use crate::parakeet_engine::model::ParakeetModel;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::fs;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::RwLock;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

pub(crate) const DOWNLOAD_CANCELLED_MESSAGE: &str = "Download cancelled by user";

/// Quantization type for Parakeet models
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum QuantizationType {
    FP32, // Full precision
    Int8, // 8-bit integer quantization (faster)
}

impl Default for QuantizationType {
    fn default() -> Self {
        QuantizationType::Int8 // Default to int8 for best performance
    }
}

/// Model status for Parakeet models
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ModelStatus {
    Available,
    Missing,
    Downloading {
        progress: u8,
    },
    Error(String),
    Corrupted {
        file_size: u64,
        expected_min_size: u64,
    },
}

/// Detailed download progress info (MB-based with speed)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    /// Bytes downloaded so far
    pub downloaded_bytes: u64,
    /// Total file size in bytes
    pub total_bytes: u64,
    /// Downloaded in MB (for display)
    pub downloaded_mb: f64,
    /// Total size in MB (for display)
    pub total_mb: f64,
    /// Download speed in MB/s
    pub speed_mbps: f64,
    /// Percentage complete (0-100)
    pub percent: u8,
}

impl DownloadProgress {
    pub fn new(downloaded: u64, total: u64, speed_mbps: f64) -> Self {
        let percent = if total > 0 {
            ((downloaded as f64 / total as f64) * 100.0).min(100.0) as u8
        } else {
            0
        };
        Self {
            downloaded_bytes: downloaded,
            total_bytes: total,
            downloaded_mb: downloaded as f64 / (1024.0 * 1024.0),
            total_mb: total as f64 / (1024.0 * 1024.0),
            speed_mbps,
            percent,
        }
    }
}

/// Information about a Parakeet model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub name: String,
    pub path: PathBuf,
    /// Bytes of the installed files, else of the files on Hugging Face
    /// (`model_catalog::sizes`); `None` while unknown.
    pub size_bytes: Option<u64>,
    pub quantization: QuantizationType,
    pub speed: String, // Performance description
    pub status: ModelStatus,
    pub description: String,
    /// From the model catalog, for Settings.
    #[serde(default)]
    pub display_name: String,
    #[serde(default)]
    pub recommended: bool,
    #[serde(default)]
    pub languages: Vec<String>,
}

#[derive(Debug)]
pub enum ParakeetEngineError {
    ModelNotLoaded,
    ModelNotFound(String),
    TranscriptionFailed(String),
    DownloadFailed(String),
    IoError(std::io::Error),
    Other(String),
}

impl std::fmt::Display for ParakeetEngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParakeetEngineError::ModelNotLoaded => write!(f, "No Parakeet model loaded"),
            ParakeetEngineError::ModelNotFound(name) => write!(f, "Model '{}' not found", name),
            ParakeetEngineError::TranscriptionFailed(err) => {
                write!(f, "Transcription failed: {}", err)
            }
            ParakeetEngineError::DownloadFailed(err) => write!(f, "Download failed: {}", err),
            ParakeetEngineError::IoError(err) => write!(f, "IO error: {}", err),
            ParakeetEngineError::Other(err) => write!(f, "Error: {}", err),
        }
    }
}

impl std::error::Error for ParakeetEngineError {}

impl From<std::io::Error> for ParakeetEngineError {
    fn from(err: std::io::Error) -> Self {
        ParakeetEngineError::IoError(err)
    }
}

pub struct ParakeetEngine {
    models_dir: PathBuf,
    current_model: Arc<RwLock<Option<ParakeetModel>>>,
    current_model_name: Arc<RwLock<Option<String>>>,
    pub(crate) available_models: Arc<RwLock<HashMap<String, ModelInfo>>>,
    cancel_downloads: Arc<RwLock<HashMap<String, Arc<CancellationToken>>>>,
    completed_cancellations: Arc<RwLock<HashSet<String>>>,
    // Active downloads tracking to prevent concurrent downloads
    pub(crate) active_downloads: Arc<RwLock<HashSet<String>>>, // Set of models currently being downloaded
    /// Where model repositories are resolved; tests use a local server.
    hub: String,
}

impl ParakeetEngine {
    /// The files the installed copy of `model_name` in `model_dir` was verified
    /// against: its install record, or the 0.3.0 pins (see
    /// `crate::model_catalog::installed`). There is no mirror: another host
    /// would only be one more party able to serve different bytes.
    fn expected_files(model_name: &str, model_dir: &Path) -> Result<Vec<&'static Pinned>> {
        let entry = model_catalog::entry(Engine::Parakeet, model_name)
            .ok_or_else(|| anyhow!("Parakeet model {} is not in the model catalog", model_name))?;
        installed::expected(&entry, &installed::record_path_for_dir(model_dir))
            .map(|expected| expected.files)
            .ok_or_else(|| anyhow!("Parakeet model {} has no verified version on record", model_name))
    }

    /// Create a new Parakeet engine with optional custom models directory
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        let models_dir = if let Some(dir) = models_dir {
            dir.join("parakeet") // Parakeet models in subdirectory
        } else {
            // Fallback to default location
            let current_dir = std::env::current_dir()
                .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;

            if cfg!(debug_assertions) {
                // Development mode
                current_dir.join("models").join("parakeet")
            } else {
                // Production mode — portable: models live next to the executable.
                crate::paths::models_dir().join("parakeet")
            }
        };

        log::info!(
            "ParakeetEngine using models directory: {}",
            models_dir.display()
        );

        // Create directory if it doesn't exist
        if !models_dir.exists() {
            std::fs::create_dir_all(&models_dir)?;
        }

        Ok(Self {
            models_dir,
            current_model: Arc::new(RwLock::new(None)),
            current_model_name: Arc::new(RwLock::new(None)),
            available_models: Arc::new(RwLock::new(HashMap::new())),
            cancel_downloads: Arc::new(RwLock::new(HashMap::new())),
            completed_cancellations: Arc::new(RwLock::new(HashSet::new())),
            // Initialize active downloads tracking
            active_downloads: Arc::new(RwLock::new(HashSet::new())),
            hub: huggingface::HUB.to_string(),
        })
    }

    /// Discover available Parakeet models
    pub async fn discover_models(&self) -> Result<Vec<ModelInfo>> {
        let models_dir = &self.models_dir;
        let mut models = Vec::new();

        // The catalog's Parakeet models; v2 is unlisted and shows only once
        // installed. Each model is a folder named after its id.
        let entries = model_catalog::offered(Engine::Parakeet, |entry| models_dir.join(&entry.id).exists());

        // Get active downloads to override status
        let active_downloads = self.active_downloads.read().await;

        for entry in &entries {
            let name = entry.id.as_str();
            // The catalog's only Parakeet format is onnx-tdt-int8.
            let quantization = QuantizationType::Int8;
            let model_path = models_dir.join(name);
            // The installed version's exact size; `None` with no version on record.
            let installed_size = Self::expected_files(name, &model_path)
                .ok()
                .map(|files| files.iter().map(|pinned| pinned.size).sum::<u64>());

            // Check if model is currently downloading
            let status = if active_downloads.contains(name) {
                // If downloading, preserve that status regardless of file system
                // We don't know the exact progress here without more state, but 0 is safe fallback
                // The progress events will update the UI
                ModelStatus::Downloading { progress: 0 }
            } else if model_path.exists() {
                // Check for required ONNX files
                let required_files = match quantization {
                    QuantizationType::Int8 => vec![
                        "encoder-model.int8.onnx",
                        "decoder_joint-model.int8.onnx",
                        "nemo128.onnx",
                        "vocab.txt",
                    ],
                    QuantizationType::FP32 => vec![
                        "encoder-model.onnx",
                        "decoder_joint-model.onnx",
                        "nemo128.onnx",
                        "vocab.txt",
                    ],
                };

                let all_files_exist = required_files
                    .iter()
                    .all(|file| model_path.join(file).exists());

                if all_files_exist {
                    // Validate model by checking file sizes
                    match self.validate_model_directory(&model_path).await {
                        Ok(_) => ModelStatus::Available,
                        Err(error) => {
                            log::warn!("Model directory {} appears corrupted: {}", name, error);
                            // Calculate total size of existing files
                            let mut total_size = 0u64;
                            for file in required_files {
                                if let Ok(metadata) = std::fs::metadata(model_path.join(file)) {
                                    total_size += metadata.len();
                                }
                            }
                            ModelStatus::Corrupted {
                                file_size: total_size,
                                expected_min_size: installed_size.unwrap_or(0),
                            }
                        }
                    }
                } else {
                    ModelStatus::Missing
                }
            } else {
                ModelStatus::Missing
            };

            // An installed model shows its own files; any other the files a
            // download would fetch now.
            let size_bytes = match status {
                ModelStatus::Available => installed_size,
                _ => model_catalog::sizes::download_size(entry),
            };
            let model_info = ModelInfo {
                name: name.to_string(),
                path: model_path,
                size_bytes,
                quantization: quantization.clone(),
                speed: entry.speed.clone().unwrap_or_default(),
                status,
                description: entry.description.clone(),
                display_name: entry.name.clone(),
                recommended: entry.recommended,
                languages: entry.languages.clone(),
            };

            models.push(model_info);
        }

        // Update internal cache
        let mut available_models = self.available_models.write().await;
        available_models.clear();
        for model in &models {
            available_models.insert(model.name.clone(), model.clone());
        }

        Ok(models)
    }

    /// Validate a model directory: every file of the installed version exists
    /// with its exact size.
    /// This runs at startup, so hashes are left to the download and to the
    /// check before the first load (see `crate::model_integrity`).
    async fn validate_model_directory(&self, model_dir: &PathBuf) -> Result<()> {
        let model_name = model_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let pinned_files = Self::expected_files(model_name, model_dir)?;

        for pinned in pinned_files {
            let file_path = model_dir.join(pinned.file);
            let actual_size = match std::fs::metadata(&file_path) {
                Ok(metadata) => metadata.len(),
                Err(_) => return Err(anyhow!("{} not found", pinned.file)),
            };
            if actual_size != pinned.size {
                return Err(anyhow!(
                    "{} has {} bytes (expected {})",
                    pinned.file,
                    actual_size,
                    pinned.size
                ));
            }
            // Failed its check earlier but could not be deleted.
            if let Some(reason) = model_integrity::rejection(pinned, &file_path) {
                return Err(anyhow!(reason));
            }
        }

        Ok(())
    }

    /// Hashes the files of a model installed before SHA-256 pinning, or changed
    /// since its download, once before ONNX Runtime parses them. A mismatch
    /// deletes the file and leaves the reason in the model status until the
    /// next discovery. Only an available model is hashed, so a download
    /// (status Downloading) is never touched; a file whose size changed since
    /// discovery is refused and kept, and its status left to the download.
    async fn verify_before_load(&self, model_name: &str) -> Result<()> {
        let model_dir = match self.available_models.read().await.get(model_name) {
            Some(info) if matches!(info.status, ModelStatus::Available) => info.path.clone(),
            // load_model reports every other status.
            _ => return Ok(()),
        };
        let pinned_files = Self::expected_files(model_name, &model_dir)?;
        for pinned in pinned_files {
            let file_path = model_dir.join(pinned.file);
            if let Err(error) = model_integrity::ensure_verified(pinned, &file_path).await {
                if matches!(error.downcast_ref(), Some(model_integrity::IntegrityError::Mismatch { .. })) {
                    if let Some(model) = self.available_models.write().await.get_mut(model_name) {
                        model.status = ModelStatus::Error(error.to_string());
                    }
                }
                return Err(error);
            }
        }
        Ok(())
    }

    /// Load a Parakeet model
    pub async fn load_model(&self, model_name: &str) -> Result<()> {
        self.verify_before_load(model_name).await?;
        let models = self.available_models.read().await;
        let model_info = models
            .get(model_name)
            .ok_or_else(|| anyhow!("Model {} not found", model_name))?;

        match model_info.status {
            ModelStatus::Available => {
                // Check if this model is already loaded
                if let Some(current_model) = self.current_model_name.read().await.as_ref() {
                    if current_model == model_name {
                        log::info!(
                            "Parakeet model {} is already loaded, skipping reload",
                            model_name
                        );
                        return Ok(());
                    }

                    // Unload current model before loading new one
                    log::info!(
                        "Unloading current Parakeet model '{}' before loading '{}'",
                        current_model,
                        model_name
                    );
                    self.unload_model().await;
                }

                log::info!("Loading Parakeet model: {}", model_name);

                // Load model based on quantization type
                let quantized = model_info.quantization == QuantizationType::Int8;
                let model = ParakeetModel::new(&model_info.path, quantized)
                    .map_err(|e| anyhow!("Failed to load Parakeet model {}: {}", model_name, e))?;

                // Update current model and model name
                *self.current_model.write().await = Some(model);
                *self.current_model_name.write().await = Some(model_name.to_string());

                log::info!(
                    "Successfully loaded Parakeet model: {} ({})",
                    model_name,
                    if quantized { "Int8 quantized" } else { "FP32" }
                );
                Ok(())
            }
            ModelStatus::Missing => Err(anyhow!("Parakeet model {} is not downloaded", model_name)),
            ModelStatus::Downloading { .. } => Err(anyhow!(
                "Parakeet model {} is currently downloading",
                model_name
            )),
            ModelStatus::Error(ref err) => {
                Err(anyhow!("Parakeet model {} has error: {}", model_name, err))
            }
            ModelStatus::Corrupted { .. } => Err(anyhow!(
                "Parakeet model {} is corrupted and cannot be loaded",
                model_name
            )),
        }
    }

    /// Unload the current model
    pub async fn unload_model(&self) -> bool {
        let mut model_guard = self.current_model.write().await;
        let unloaded = model_guard.take().is_some();
        if unloaded {
            log::info!("Parakeet model unloaded");
        }

        let mut model_name_guard = self.current_model_name.write().await;
        model_name_guard.take();

        unloaded
    }

    /// Get the currently loaded model name
    pub async fn get_current_model(&self) -> Option<String> {
        self.current_model_name.read().await.clone()
    }

    /// Check if a model is loaded
    pub async fn is_model_loaded(&self) -> bool {
        self.current_model.read().await.is_some()
    }

    /// Transcribe audio samples using the loaded Parakeet model and optional
    /// comma- or newline-separated vocabulary phrases.
    pub async fn transcribe_audio(
        &self,
        audio_data: Vec<f32>,
        vocabulary: Option<&str>,
    ) -> Result<String> {
        let mut model_guard = self.current_model.write().await;
        let model = model_guard
            .as_mut()
            .ok_or_else(|| anyhow!("No Parakeet model loaded. Please load a model first."))?;

        let duration_seconds = audio_data.len() as f64 / 16000.0; // Assuming 16kHz
        log::debug!(
            "Parakeet transcribing {} samples ({:.1}s duration)",
            audio_data.len(),
            duration_seconds
        );

        // Transcribe using Parakeet model
        let result = model
            .transcribe_samples(audio_data, vocabulary)
            .map_err(|e| anyhow!("Parakeet transcription failed: {}", e))?;

        log::debug!("Parakeet transcription result: '{}'", result.text);

        Ok(result.text)
    }

    /// Get the models directory path
    pub async fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }

    /// Delete a corrupted model
    pub async fn delete_model(&self, model_name: &str) -> Result<String> {
        log::info!("Attempting to delete Parakeet model: {}", model_name);

        // Get model info to find the directory path
        let model_info = {
            let models = self.available_models.read().await;
            models.get(model_name).cloned()
        };

        let model_info =
            model_info.ok_or_else(|| anyhow!("Parakeet model '{}' not found", model_name))?;

        log::info!(
            "Parakeet model '{}' has status: {:?}",
            model_name,
            model_info.status
        );

        // Allow deletion of corrupted or available models
        match &model_info.status {
            ModelStatus::Corrupted { .. } | ModelStatus::Available => {
                // Delete the entire model directory
                if model_info.path.exists() {
                    fs::remove_dir_all(&model_info.path).await
                        .map_err(|e| anyhow!("Failed to delete directory '{}': {}", model_info.path.display(), e))?;
                    log::info!("Successfully deleted Parakeet model directory: {}", model_info.path.display());
                } else {
                    log::warn!("Directory '{}' does not exist, nothing to delete", model_info.path.display());
                }

                // Update model status to Missing
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model) = models.get_mut(model_name) {
                        model.status = ModelStatus::Missing;
                    }
                }

                Ok(format!("Successfully deleted Parakeet model '{}'", model_name))
            }
            _ => {
                Err(anyhow!(
                    "Can only delete corrupted or available Parakeet models. Model '{}' has status: {:?}",
                    model_name,
                    model_info.status
                ))
            }
        }
    }

    /// Download a Parakeet model from HuggingFace (backward-compatible wrapper)
    pub async fn download_model(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(u8) + Send>>,
    ) -> Result<()> {
        // Wrap simple callback to use detailed version
        let detailed_callback: Option<Box<dyn Fn(DownloadProgress) + Send>> = progress_callback
            .map(|cb| {
                Box::new(move |p: DownloadProgress| cb(p.percent))
                    as Box<dyn Fn(DownloadProgress) + Send>
            });
        self.download_model_detailed(model_name, detailed_callback)
            .await
    }

    /// Download a Parakeet model with detailed progress (MB/speed/resume support)
    pub async fn download_model_detailed(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        log::info!("Starting download for Parakeet model: {}", model_name);

        let cancellation = Arc::new(CancellationToken::new());
        {
            let mut active = self.active_downloads.write().await;
            if !active.insert(model_name.to_string()) {
                log::warn!(
                    "Download already in progress for Parakeet model: {}",
                    model_name
                );
                return Err(anyhow!(
                    "Download already in progress for model: {}",
                    model_name
                ));
            }
            // Publish/reset per-attempt cancellation under the ownership lock.
            self.cancel_downloads.write().await.insert(model_name.to_string(), cancellation.clone());
            self.completed_cancellations.write().await.remove(model_name);
        }

        let result = self
            .download_model_detailed_reserved(model_name, progress_callback, &cancellation)
            .await;
        if let Err(error) = &result {
            let mut models = self.available_models.write().await;
            if let Some(model) = models.get_mut(model_name) {
                model.status = if error.to_string() == DOWNLOAD_CANCELLED_MESSAGE {
                    ModelStatus::Missing
                } else {
                    ModelStatus::Error(error.to_string())
                };
            }
        }
        if result.as_ref().is_err_and(|error| error.to_string() == DOWNLOAD_CANCELLED_MESSAGE) {
            self.completed_cancellations
                .write()
                .await
                .insert(model_name.to_string());
        } else {
            let mut active = self.active_downloads.write().await;
            self.cancel_downloads.write().await.remove(model_name);
            active.remove(model_name);
        }
        result
    }

    async fn download_model_detailed_reserved(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
        cancellation: &CancellationToken,
    ) -> Result<()> {
        // Get model info
        let model_info = {
            let models = self.available_models.read().await;
            match models.get(model_name).cloned() {
                Some(info) => info,
                None => {
                    return Err(anyhow!("Model {} not found", model_name));
                }
            }
        };

        // Update model status to downloading
        {
            let mut models = self.available_models.write().await;
            if let Some(model) = models.get_mut(model_name) {
                model.status = ModelStatus::Downloading { progress: 0 };
            }
        }

        let Some(entry) = model_catalog::entry(Engine::Parakeet, model_name) else {
            return Err(anyhow!("Parakeet model {} is not in the model catalog", model_name));
        };
        let model_dir = &model_info.path;
        let record_path = installed::record_path_for_dir(model_dir);
        // The commit and file pins to download: an unfinished download keeps
        // its own, so the bytes it kept stay valid.
        let api = huggingface::client();
        let plan = tokio::select! {
            _ = cancellation.cancelled() => return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE)),
            plan = installed::plan_download(&api, &self.hub, &entry, &record_path) => plan?,
        };
        let pinned_files: Vec<&'static Pinned> = plan.resolved.files.iter().map(|file| file.pinned).collect();

        // Create model directory
        if !model_dir.exists() {
            if let Err(e) = fs::create_dir_all(model_dir).await {
                return Err(anyhow!("Failed to create model directory: {}", e));
            }
        }
        if !plan.keep_partial {
            // Partial files of another version would only fail the final hash.
            for pinned in &pinned_files {
                let path = model_dir.join(pinned.file);
                if fs::metadata(&path).await.is_ok_and(|metadata| metadata.len() < pinned.size) {
                    let _ = fs::remove_file(&path).await;
                }
            }
        }
        // Written before any byte, so an interrupted download resumes from the
        // same commit; it says complete only once every file matched.
        installed::write_record(&record_path, &installed::InstallRecord::from_resolved(&entry.id, &plan.resolved, false))
            .map_err(|e| anyhow!("Failed to write the install record of {}: {}", model_name, e))?;

        // Optimized HTTP client for large file downloads
        let client = huggingface::builder()
            .tcp_nodelay(true) // Disable Nagle's algorithm for better streaming
            .pool_max_idle_per_host(1) // Keep connection alive
            .timeout(Duration::from_secs(3600)) // 1 hour timeout for large files
            .connect_timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| anyhow!("Failed to create HTTP client: {}", e))?;

        let total_files = pinned_files.len();

        // Calculate total expected download size
        let total_size_bytes: u64 = pinned_files.iter().map(|pinned| pinned.size).sum();

        // Check for existing downloads (complete or partial) to calculate resume offset
        let mut already_downloaded: u64 = 0;
        for pinned in &pinned_files {
            if let Ok(metadata) = fs::metadata(model_dir.join(pinned.file)).await {
                let file_size = metadata.len();
                // Count all existing bytes (complete files capped at expected size, partial as-is)
                // This ensures progress starts from where we left off
                if file_size <= pinned.size {
                    already_downloaded += file_size;
                }
            }
        }

        let mut total_downloaded: u64 = already_downloaded;
        // Hashing a kept file runs on a blocking thread and polls this between
        // 1 MiB reads, so Cancel does not wait for hundreds of megabytes.
        let cancel_flag = || {
            let token = cancellation.clone();
            move || token.is_cancelled()
        };

        // Timing for speed calculation
        let download_start_time = Instant::now();
        let mut last_report_time = Instant::now();
        let mut bytes_since_last_report: u64 = 0;
        let mut last_reported_progress: u8 = 0;

        log::info!(
            "Starting weighted download for {} files, total size: {:.2} MB (already downloaded: {:.2} MB)",
            total_files,
            total_size_bytes as f64 / 1_048_576.0,
            already_downloaded as f64 / 1_048_576.0
        );

        for (index, pinned) in pinned_files.iter().enumerate() {
            let filename = pinned.file;
            let file_path = model_dir.join(filename);

            // Check for existing partial file to resume
            let existing_size: u64 = if file_path.exists() {
                fs::metadata(&file_path).await.map(|m| m.len()).unwrap_or(0)
            } else {
                0
            };

            let expected_size = pinned.size;

            if existing_size == expected_size {
                // A complete file left by an earlier attempt or an older build
                // is hashed once rather than trusted for its size.
                match model_integrity::ensure_verified_cancellable(pinned, &file_path, cancel_flag()).await {
                    Ok(()) => {
                        log::info!(
                            "Skipping verified file: {} ({:.2} MB)",
                            filename,
                            expected_size as f64 / 1_048_576.0
                        );
                        continue;
                    }
                    Err(_) if cancellation.is_cancelled() => return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE)),
                    Err(error) => {
                        log::warn!("{}; downloading it again", error);
                        total_downloaded = total_downloaded.saturating_sub(existing_size);
                    }
                }
            }

            if existing_size > expected_size {
                fs::remove_file(&file_path)
                    .await
                    .map_err(|e| anyhow!("Failed to remove oversized {}: {}", filename, e))?;
            }
            if cancellation.is_cancelled() {
                return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
            }
            let resume_size = fs::metadata(&file_path)
                .await
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            log::info!(
                "Downloading file {}/{}: {} (resuming from {} bytes)",
                index + 1,
                total_files,
                filename,
                resume_size
            );

            let file_url = plan.resolved.files[index].url.clone();
            let (response, resuming) = match super::download_response::artifact_response(
                &client, &file_url, resume_size, expected_size, cancellation,
            ).await {
                Ok(result) => result,
                Err(_) if cancellation.is_cancelled() => return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE)),
                Err(error) => {
                    return Err(anyhow!(
                        "Could not download {}. Check your connection, VPN, firewall, or proxy, then retry. Details: {}",
                        filename,
                        error
                    ));
                }
            };
            let file_total_size = expected_size;
            // The hash covers the whole file, so a resumed transfer first reads
            // back the bytes it keeps.
            let mut check = if resuming {
                match model_integrity::Check::resume(pinned, &file_path, cancel_flag()).await {
                    Ok(check) => check,
                    // The partial file is untouched and stays for the next resume.
                    Err(_) if cancellation.is_cancelled() => return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE)),
                    Err(e) => return Err(anyhow!("Failed to read partial {}: {}", filename, e)),
                }
            } else {
                model_integrity::Check::new(pinned)
            };

            log::info!("Downloading {} from {}", filename, file_url);
            let file = if resuming {
                fs::OpenOptions::new()
                    .append(true)
                    .open(&file_path)
                    .await
                    .map_err(|e| {
                        anyhow!("Failed to open file for resume {}: {}", filename, e)
                    })?
            } else {
                total_downloaded = total_downloaded.saturating_sub(resume_size);
                fs::File::create(&file_path)
                    .await
                    .map_err(|e| anyhow!("Failed to create file {}: {}", filename, e))?
            };
            let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);
            use futures_util::StreamExt;
            let mut stream = response.bytes_stream();
            let mut file_downloaded = if resuming { resume_size } else { 0 };
            let mut transfer_error = None;

            loop {
                if cancellation.is_cancelled() {
                    let _ = writer.flush().await;
                    return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
                }

                let next = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => {
                        writer.flush().await?;
                        return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
                    }
                    result = timeout(Duration::from_secs(30), stream.next()) => result,
                };
                let chunk = match next {
                    Err(_) => {
                        transfer_error = Some("no data received for 30 seconds".to_string());
                        break;
                    }
                    Ok(None) => break,
                    Ok(Some(Err(error))) => {
                        transfer_error = Some(error.to_string());
                        break;
                    }
                    Ok(Some(Ok(chunk))) => chunk,
                };

                if let Err(error) = check.update(&chunk) {
                    transfer_error = Some(error.to_string());
                    break;
                }
                writer
                    .write_all(&chunk)
                    .await
                    .map_err(|e| anyhow!("Failed to write chunk to file: {}", e))?;
                let chunk_len = chunk.len() as u64;
                file_downloaded += chunk_len;
                total_downloaded += chunk_len;
                bytes_since_last_report += chunk_len;

                let overall_progress = if total_size_bytes > 0 {
                    ((total_downloaded as f64 / total_size_bytes as f64) * 100.0).min(99.0)
                        as u8
                } else {
                    ((index as f64 + (file_downloaded as f64 / file_total_size.max(1) as f64))
                        / total_files as f64
                        * 100.0) as u8
                };
                let elapsed_since_report = last_report_time.elapsed();
                if overall_progress > last_reported_progress
                    || elapsed_since_report >= Duration::from_millis(500)
                    || file_downloaded >= file_total_size
                {
                    let speed_mbps = if elapsed_since_report.as_secs_f64() >= 0.1 {
                        (bytes_since_last_report as f64 / (1024.0 * 1024.0))
                            / elapsed_since_report.as_secs_f64()
                    } else {
                        0.0
                    };
                    last_reported_progress = overall_progress;
                    last_report_time = Instant::now();
                    bytes_since_last_report = 0;
                    if let Some(ref callback) = progress_callback {
                        // At most 99%, like the status: the last chunk of the
                        // last file arrives before that file is checked.
                        callback(DownloadProgress {
                            percent: overall_progress,
                            ..DownloadProgress::new(total_downloaded, total_size_bytes, speed_mbps)
                        });
                    }
                    if let Some(model) = self.available_models.write().await.get_mut(model_name)
                    {
                        model.status = ModelStatus::Downloading {
                            progress: overall_progress,
                        };
                    }
                }
            }

            writer
                .flush()
                .await
                .map_err(|e| anyhow!("Failed to flush file {}: {}", filename, e))?;
            // Close the file before its marker records its modification time.
            drop(writer);
            let final_size = fs::metadata(&file_path)
                .await
                .map_err(|e| anyhow!("Failed to inspect {}: {}", filename, e))?
                .len();
            if final_size != expected_size {
                return Err(anyhow!(
                    "Could not download {}: stopped at {} of {} bytes{}. Check your connection, VPN, firewall, or proxy, then retry.",
                    filename,
                    final_size,
                    expected_size,
                    transfer_error
                        .map(|error| format!(" ({})", error))
                        .unwrap_or_default()
                ));
            }
            check.finish(&file_path)?;
            model_integrity::mark_verified(pinned, &file_path);

            log::info!(
                "Completed download: {} ({:.2} MB, overall progress: {:.1}%)",
                filename,
                expected_size as f64 / 1_048_576.0,
                (total_downloaded as f64 / total_size_bytes as f64) * 100.0
            );
        }

        if cancellation.is_cancelled() {
            return Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE));
        }
        installed::write_record(&record_path, &installed::InstallRecord::from_resolved(&entry.id, &plan.resolved, true))
            .map_err(|e| anyhow!("Failed to write the install record of {}: {}", model_name, e))?;
        self.validate_model_directory(model_dir)
            .await
            .map_err(|error| anyhow!("Downloaded Parakeet model failed validation: {}", error))?;

        // Report 100% only after every file passes exact validation.
        let total_elapsed = download_start_time.elapsed().as_secs_f64();
        let final_speed = if total_elapsed > 0.0 {
            (total_downloaded.saturating_sub(already_downloaded) as f64 / (1024.0 * 1024.0)) / total_elapsed
        } else {
            0.0
        };
        let final_progress = DownloadProgress::new(total_size_bytes, total_size_bytes, final_speed);
        if let Some(ref callback) = progress_callback {
            callback(final_progress);
        }

        // Update model status to available
        {
            let mut models = self.available_models.write().await;
            if let Some(model) = models.get_mut(model_name) {
                model.status = ModelStatus::Available;
                model.path = model_dir.clone();
            }
        }

        log::info!("Download completed for Parakeet model: {}", model_name);
        Ok(())
    }

    /// Cancel an ongoing model download
    pub async fn cancel_download(&self, model_name: &str) -> Result<Arc<CancellationToken>> {
        log::info!("Cancelling download for Parakeet model: {}", model_name);

        let active = self.active_downloads.read().await;
        if !active.contains(model_name) {
            return Err(anyhow!("No download in progress for model: {}", model_name));
        }
        let token = self.cancel_downloads.read().await.get(model_name).cloned()
            .ok_or_else(|| anyhow!("Download cancellation is not registered"))?;
        token.cancel();

        // The worker flushes and retains partial files so a later attempt can
        // resume instead of redownloading hundreds of megabytes.

        Ok(token)
    }

    pub(crate) async fn cancellation_completed(&self, model_name: &str) -> bool {
        self.completed_cancellations.read().await.contains(model_name)
    }

    pub(crate) async fn download_is_current(&self, model_name: &str, token: &Arc<CancellationToken>) -> bool {
        self.cancel_downloads.read().await.get(model_name).is_some_and(|current| Arc::ptr_eq(current, token))
    }

    pub(crate) async fn release_cancelled_download(
        &self, model_name: &str, token: &Arc<CancellationToken>, emit_terminal: impl FnOnce(),
    ) -> bool {
        let mut active = self.active_downloads.write().await;
        if !self.download_is_current(model_name, token).await ||
            !self.completed_cancellations.read().await.contains(model_name) { return false; }
        // A duplicate/stale Cancel cannot clear the next attempt or emit its
        // terminal event after Retry has begun.
        emit_terminal();
        self.completed_cancellations.write().await.remove(model_name);
        self.cancel_downloads.write().await.remove(model_name);
        active.remove(model_name);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn early_download_failure_releases_ownership() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let dir = tempfile::tempdir().unwrap();
        let engine = ParakeetEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
        assert!(engine.download_model_detailed("not-a-model", None).await.is_err());
        assert!(!engine.active_downloads.read().await.contains("not-a-model"));
        assert!(!engine.cancel_downloads.read().await.contains_key("not-a-model"));
    }

    #[tokio::test]
    async fn cancellation_is_per_model_and_stale_release_cannot_clear_retry() {
        let dir = tempfile::tempdir().unwrap();
        let engine = ParakeetEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
        let a = Arc::new(CancellationToken::new());
        let b = Arc::new(CancellationToken::new());
        engine.active_downloads.write().await.extend(["a".into(), "b".into()]);
        engine.cancel_downloads.write().await.extend([("a".into(), a.clone()), ("b".into(), b.clone())]);
        let cancelled = engine.cancel_download("a").await.unwrap();
        assert!(a.is_cancelled());
        assert!(!b.is_cancelled());
        engine.completed_cancellations.write().await.insert("a".into());
        assert!(engine.release_cancelled_download("a", &cancelled, || {}).await);
        let retry = Arc::new(CancellationToken::new());
        engine.active_downloads.write().await.insert("a".into());
        engine.cancel_downloads.write().await.insert("a".into(), retry.clone());
        assert!(!engine.release_cancelled_download("a", &cancelled, || panic!("stale event")).await);
        assert!(engine.download_is_current("a", &retry).await);
        assert!(!retry.is_cancelled());
    }

    /// The 0.3.0 pins of `model`, as a model installed by 0.3.x is checked.
    fn legacy_files(model: &str) -> &'static [Pinned] {
        installed::legacy_model(Engine::Parakeet, model).unwrap().files
    }

    #[tokio::test]
    async fn discovery_lists_the_unlisted_v2_only_once_installed() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let dir = tempfile::tempdir().unwrap();
        let engine = ParakeetEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
        let names = |models: Vec<ModelInfo>| models.into_iter().map(|model| model.name).collect::<Vec<_>>();
        let models = engine.discover_models().await.unwrap();
        // Not installed, and Hugging Face was not asked: no size, not a guess.
        assert_eq!(models[0].size_bytes, None);
        let listed = names(models);
        assert_eq!(listed, ["parakeet-tdt-0.6b-v3-int8"]);
        std::fs::create_dir_all(dir.path().join("parakeet").join("parakeet-tdt-0.6b-v2-int8")).unwrap();
        let listed = names(engine.discover_models().await.unwrap());
        assert_eq!(listed, ["parakeet-tdt-0.6b-v3-int8", "parakeet-tdt-0.6b-v2-int8"]);
    }

    #[tokio::test]
    async fn a_download_resolves_the_current_commit_and_records_it() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        use crate::model_catalog::testing::Hub;
        const COMMIT: &str = "1111111111111111111111111111111111111111";
        let model = "parakeet-tdt-0.6b-v3-int8";
        let mut hub = Hub::new();
        hub.repo("istupakov/parakeet-tdt-0.6b-v3-onnx", COMMIT)
            .lfs_file("encoder-model.int8.onnx", &[1u8; 4096])
            .lfs_file("decoder_joint-model.int8.onnx", &[2u8; 512])
            .lfs_file("nemo128.onnx", &[3u8; 64])
            .git_file("vocab.txt", b"<unk>\n");
        let hub = hub.serve().await;
        let dir = tempfile::tempdir().unwrap();
        let mut engine = ParakeetEngine::new_with_models_dir(Some(dir.path().to_path_buf())).unwrap();
        engine.hub = hub.url.clone();
        engine.discover_models().await.unwrap();

        engine.download_model_detailed(model, None).await.unwrap();
        let model_dir = dir.path().join("parakeet").join(model);
        let record = installed::read_record(&installed::record_path_for_dir(&model_dir)).unwrap();
        assert!(record.complete);
        assert_eq!(record.commit, COMMIT);
        assert_eq!(std::fs::read(model_dir.join("nemo128.onnx")).unwrap(), [3u8; 64]);
        // The record, not the 0.3.0 pins, is what the model is now checked against.
        engine.discover_models().await.unwrap();
        let info = engine.available_models.read().await[model].clone();
        assert!(matches!(info.status, ModelStatus::Available));
        assert_eq!(ParakeetEngine::expected_files(model, &model_dir).unwrap()[0].size, 4096);
        // An installed model shows the size of its own files.
        assert_eq!(info.size_bytes, Some(4096 + 512 + 64 + 6));
    }

    #[tokio::test]
    async fn load_deletes_a_tampered_file_and_trusts_files_verified_before() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let model = "parakeet-tdt-0.6b-v2-int8";
        let model_dir = temp.path().join("parakeet").join(model);
        std::fs::create_dir_all(&model_dir).expect("model directory");
        for pinned in legacy_files(model) {
            let path = model_dir.join(pinned.file);
            // Synchronous so each file is closed before its marker is written.
            std::fs::File::create(&path).unwrap().set_len(pinned.size).unwrap();
            // Markers stand for an earlier verified download; hashing these
            // zero-filled files would fail, so the test shows they are skipped.
            if pinned.file != "vocab.txt" {
                model_integrity::mark_verified(pinned, &path);
            }
        }

        let engine =
            ParakeetEngine::new_with_models_dir(Some(temp.path().to_path_buf())).expect("engine");
        engine.discover_models().await.expect("discover models");
        let error = engine.load_model(model).await.unwrap_err().to_string();
        assert!(error.contains("vocab.txt failed its integrity check and was deleted"), "{error}");
        assert!(!model_dir.join("vocab.txt").exists());
        assert!(model_dir.join("encoder-model.int8.onnx").exists());
        assert!(matches!(
            engine.available_models.read().await[model].status,
            ModelStatus::Error(_)
        ));
    }

    #[tokio::test]
    async fn cancel_stops_hashing_a_kept_file_at_once() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let model = "parakeet-tdt-0.6b-v3-int8";
        let model_dir = temp.path().join("parakeet").join(model);
        std::fs::create_dir_all(&model_dir).expect("model directory");
        // A complete encoder left by an older build, never verified: 650 MB
        // to hash before the download would move on (and fail: it is zeros).
        let encoder = model_integrity::find(legacy_files(model), "encoder-model.int8.onnx").unwrap();
        let path = model_dir.join(encoder.file);
        std::fs::File::create(&path).unwrap().set_len(encoder.size).unwrap();
        // An unfinished download of the 0.3.0 commit: resumed without asking
        // Hugging Face, so the test stays offline.
        let legacy = installed::legacy_model(Engine::Parakeet, model).unwrap();
        let record = installed::InstallRecord {
            id: model.to_string(),
            repo: legacy.repo.to_string(),
            commit: legacy.commit.to_string(),
            complete: false,
            files: legacy
                .files
                .iter()
                .map(|pinned| installed::RecordFile {
                    name: pinned.file.to_string(),
                    size: pinned.size,
                    sha256: pinned.sha256.to_string(),
                    git_oid: None,
                })
                .collect(),
        };
        installed::write_record(&installed::record_path_for_dir(&model_dir), &record).unwrap();
        let engine = Arc::new(ParakeetEngine::new_with_models_dir(Some(temp.path().to_path_buf())).unwrap());
        engine.discover_models().await.unwrap();

        let download = tokio::spawn({
            let engine = engine.clone();
            async move { engine.download_model_detailed(model, None).await }
        });
        while !matches!(engine.available_models.read().await[model].status, ModelStatus::Downloading { .. }) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        engine.cancel_download(model).await.unwrap();
        let error = timeout(Duration::from_secs(1), download)
            .await
            .expect("the download stops within a second")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.to_string(), DOWNLOAD_CANCELLED_MESSAGE);
        // Neither deleted as a mismatch nor marked as verified.
        assert_eq!(std::fs::metadata(&path).unwrap().len(), encoder.size);
        assert!(!model_dir.join("encoder-model.int8.onnx.verified").exists());
    }

    #[tokio::test]
    async fn v3_validation_requires_exact_published_sizes() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let model_dir = temp.path().join("parakeet-tdt-0.6b-v3-int8");
        fs::create_dir_all(&model_dir)
            .await
            .expect("model directory");
        for (name, size) in [
            ("encoder-model.int8.onnx", 652_183_999),
            ("decoder_joint-model.int8.onnx", 18_202_004),
            ("nemo128.onnx", 139_764),
            ("vocab.txt", 93_939),
        ] {
            let file = fs::File::create(model_dir.join(name))
                .await
                .expect("model file");
            file.set_len(size).await.expect("model size");
        }

        let engine =
            ParakeetEngine::new_with_models_dir(Some(temp.path().to_path_buf())).expect("engine");
        engine
            .validate_model_directory(&model_dir)
            .await
            .expect("exact model");

        let encoder = fs::OpenOptions::new()
            .write(true)
            .open(model_dir.join("encoder-model.int8.onnx"))
            .await
            .expect("encoder");
        encoder
            .set_len(652_183_998)
            .await
            .expect("truncate encoder");
        assert!(engine.validate_model_directory(&model_dir).await.is_err());
    }

    #[tokio::test]
    async fn download_published_v3_model() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        if std::env::var_os("PARAKEET_DOWNLOAD_TEST").is_none() {
            return;
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let engine = ParakeetEngine::new_with_models_dir(Some(temp.path().to_path_buf()))
            .expect("engine");
        engine.discover_models().await.expect("discover models");
        engine
            .download_model_detailed("parakeet-tdt-0.6b-v3-int8", None)
            .await
            .expect("download model");
        let model_dir = temp
            .path()
            .join("parakeet")
            .join("parakeet-tdt-0.6b-v3-int8");
        engine
            .validate_model_directory(&model_dir)
            .await
            .expect("validate model");
    }
}
