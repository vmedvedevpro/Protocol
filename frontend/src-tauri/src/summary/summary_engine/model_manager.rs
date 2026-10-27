// Model manager for built-in AI models - handles downloads and lifecycle
// Follows the same pattern as whisper_engine/whisper_engine.rs for consistency

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::{Notify, RwLock};
use tokio::time::timeout;

use super::models::{get_model_by_name, installed_pin, ModelDef};
use crate::model_catalog::{self, huggingface, installed, schema::Engine};
use crate::model_integrity::{self, IntegrityError, Pinned};

// ============================================================================
// Model Status Types
// ============================================================================

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
            ((downloaded as f64 / total as f64) * 100.0) as u8
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

/// Model status in the system
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ModelStatus {
    /// Model is not yet downloaded
    NotDownloaded,

    /// Model is currently being downloaded (progress 0-100)
    Downloading { progress: u8 },

    /// Model is downloaded and ready to use
    Available,

    /// A resumable partial download exists on disk.
    Incomplete { file_size: u64, expected_size: u64 },

    /// Model file is corrupted and needs redownload
    Corrupted { file_size: u64, expected_min_size: u64 },

    /// Error occurred with the model. A struct variant: the internally tagged
    /// enum cannot serialize a newtype holding a string, and the UI reads
    /// `{ "type": "error", "message": … }`.
    Error { message: String },
}

/// Model information for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    /// Model name (e.g., "gemma3:1b")
    pub name: String,

    /// Display name for UI
    pub display_name: String,

    /// Current status
    pub status: ModelStatus,

    /// File path (if available)
    pub path: PathBuf,

    /// Size in MB
    pub size_mb: u64,

    /// Context window size in tokens
    pub context_size: u32,

    /// Description
    pub description: String,

    /// GGUF filename on disk
    pub gguf_file: String,

    /// From the model catalog, for Settings.
    #[serde(default)]
    pub recommended: bool,
}

// ============================================================================
// Model Manager
// ============================================================================

struct DownloadControl {
    cancelled: AtomicBool,
    notify: Notify,
}

impl DownloadControl {
    /// The cancel check for hashing on a blocking thread, which cannot wait on
    /// `notify`. `cancel_download` waits only seconds for the download to end.
    fn cancel_flag(self: &Arc<Self>) -> impl Fn() -> bool + Send + 'static {
        let control = self.clone();
        move || control.cancelled.load(Ordering::Acquire)
    }
}

pub struct ModelManager {
    /// Directory where models are stored
    models_dir: PathBuf,

    /// Currently available models with their status
    available_models: Arc<RwLock<HashMap<String, ModelInfo>>>,

    /// One owner and cancellation signal per active model download.
    download_controls: Arc<RwLock<HashMap<String, Arc<DownloadControl>>>>,

    /// Where model repositories are resolved; tests use a local server.
    hub: String,
}

/// What a catalog download writes beside the file: the install record, first
/// unfinished and then complete, and whether a partial file may be resumed.
struct Install {
    record_path: PathBuf,
    record: installed::InstallRecord,
    keep_partial: bool,
}

impl Install {
    fn write(&self, complete: bool) -> std::io::Result<()> {
        let record = installed::InstallRecord { complete, ..self.record.clone() };
        installed::write_record(&self.record_path, &record)
    }
}

/// The manager kept in Tauri state, for the summary client, which runs without
/// an app handle and must still see downloads and record failed checks.
static REGISTERED: Lazy<std::sync::RwLock<Weak<ModelManager>>> =
    Lazy::new(|| std::sync::RwLock::new(Weak::new()));

impl ModelManager {
    /// Makes this the manager that [`ModelManager::registered`] returns.
    pub fn register(self: &Arc<Self>) {
        *REGISTERED.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = Arc::downgrade(self);
    }

    pub fn registered() -> Option<Arc<Self>> {
        REGISTERED.read().unwrap_or_else(|poisoned| poisoned.into_inner()).upgrade()
    }

    /// Create a new model manager with default models directory
    pub fn new() -> Result<Self> {
        Self::new_with_models_dir(None)
    }

    /// Create a new model manager with custom models directory
    pub fn new_with_models_dir(models_dir: Option<PathBuf>) -> Result<Self> {
        let models_dir = if let Some(dir) = models_dir {
            dir
        } else {
            // Fallback: Use current directory in development
            let current_dir = std::env::current_dir()
                .map_err(|e| anyhow!("Failed to get current directory: {}", e))?;

            if cfg!(debug_assertions) {
                // Development mode
                current_dir.join("models").join("summary")
            } else {
                // Production mode fallback (caller should provide path).
                // Portable: models live next to the executable.
                log::warn!("ModelManager: No models directory provided, using install-local fallback");
                crate::paths::models_dir().join("summary")
            }
        };

        log::info!(
            "Built-in AI ModelManager using directory: {}",
            models_dir.display()
        );

        Ok(Self {
            models_dir,
            available_models: Arc::new(RwLock::new(HashMap::new())),
            download_controls: Arc::new(RwLock::new(HashMap::new())),
            hub: huggingface::HUB.to_string(),
        })
    }

    /// Initialize and scan for existing models
    pub async fn init(&self) -> Result<()> {
        // Create models directory if it doesn't exist
        if !self.models_dir.exists() {
            fs::create_dir_all(&self.models_dir).await?;
            log::info!("Created models directory: {}", self.models_dir.display());
        }

        // Scan for existing models
        self.scan_models().await?;

        Ok(())
    }

    /// Scan models directory and update status
    pub async fn scan_models(&self) -> Result<()> {
        let start = std::time::Instant::now();

        log::info!(
            "Starting model scan in directory: {}",
            self.models_dir.display()
        );

        // Listed catalog models, and unlisted or dropped ones still installed.
        let entries = model_catalog::offered(Engine::Llama, |entry| {
            self.models_dir.join(&entry.single_file().name).exists()
        });
        let mut models_map = HashMap::new();

        for entry in &entries {
            let Some(model_def) = ModelDef::from_entry(entry) else { continue };
            let model_path = self.models_dir.join(&model_def.gguf_file);
            log::debug!(
                "Checking model '{}' at path: {}",
                model_def.name,
                model_path.display()
            );

            let is_actively_downloading = {
                self.download_controls.read().await.contains_key(&model_def.name)
            };

            // If actively downloading, preserve existing status from memory
            if is_actively_downloading {
                let existing_info = {
                    let models = self.available_models.read().await;
                    models.get(&model_def.name).cloned()
                };

                if let Some(info) = existing_info {
                    // Preserve existing status (should be Downloading)
                    models_map.insert(model_def.name.clone(), info);
                    log::debug!(
                        "Model '{}': Preserving Downloading status during scan",
                        model_def.name
                    );
                    continue;
                }
            }

            // The installed version's exact size; none while a download has
            // not finished.
            let pinned = installed_pin(&model_def.name, &model_path);
            let status = if model_path.exists() {
                // Check if file size matches expected size (basic validation)
                match fs::metadata(&model_path).await {
                    Ok(metadata) => {
                        let file_size_bytes = metadata.len();
                        let file_size_mb = file_size_bytes / (1024 * 1024);

                        let expected_min = (model_def.size_mb as f64 * 0.9) as u64;

                        log::info!(
                            "Model '{}': found {} bytes (expected exactly {} bytes)",
                            model_def.name,
                            file_size_bytes,
                            pinned.map_or(0, |pinned| pinned.size)
                        );

                        // A file that failed its check but could not be deleted
                        // still has the pinned size.
                        let rejection = pinned.and_then(|pinned| model_integrity::rejection(pinned, &model_path));
                        if let Some(reason) = rejection {
                            log::warn!("Model '{}': CORRUPTED ({})", model_def.name, reason);
                            ModelStatus::Corrupted {
                                file_size: file_size_mb,
                                expected_min_size: model_def.size_mb,
                            }
                        } else if Some(file_size_bytes) == pinned.map(|pinned| pinned.size) {
                            match self.validate_gguf_file(&model_path).await {
                                Ok(()) => {
                                    log::info!("Model '{}': AVAILABLE", model_def.name);
                                    ModelStatus::Available
                                }
                                Err(error) => {
                                    log::warn!("Model '{}': CORRUPTED ({})", model_def.name, error);
                                    ModelStatus::Corrupted {
                                        file_size: file_size_mb,
                                        expected_min_size: model_def.size_mb,
                                    }
                                }
                            }
                        } else if pinned.map_or(true, |pinned| file_size_bytes < pinned.size) {
                            log::info!(
                                "Model '{}': INCOMPLETE ({} MB of approximately {} MB); download can resume",
                                model_def.name,
                                file_size_mb,
                                model_def.size_mb
                            );
                            ModelStatus::Incomplete {
                                file_size: file_size_mb,
                                expected_size: model_def.size_mb,
                            }
                        } else {
                            log::warn!(
                                "Model '{}': CORRUPTED (size mismatch: {} MB, expected {} MB)",
                                model_def.name,
                                file_size_mb,
                                model_def.size_mb
                            );
                            ModelStatus::Corrupted {
                                file_size: file_size_mb,
                                expected_min_size: expected_min,
                            }
                        }
                    }
                    Err(e) => {
                        log::error!(
                            "Model '{}': Failed to read metadata: {}",
                            model_def.name,
                            e
                        );
                        ModelStatus::Error {
                            message: format!("Failed to read metadata: {}", e),
                        }
                    }
                }
            } else {
                log::debug!("Model '{}': NOT FOUND", model_def.name);
                ModelStatus::NotDownloaded
            };

            let model_info = ModelInfo {
                name: model_def.name.clone(),
                display_name: model_def.display_name.clone(),
                status,
                path: model_path,
                size_mb: model_def.size_mb,
                context_size: model_def.context_size,
                description: model_def.description.clone(),
                gguf_file: model_def.gguf_file.clone(),
                recommended: entry.recommended,
            };

            models_map.insert(model_def.name.clone(), model_info);
        }

        let model_count = models_map.len();

        let mut models = self.available_models.write().await;
        *models = models_map;

        let elapsed = start.elapsed();
        log::info!(
            "Model scan complete: {} models checked in {:?}",
            model_count,
            elapsed
        );
        Ok(())
    }

    /// Get list of all models with their status
    pub async fn list_models(&self) -> Vec<ModelInfo> {
        self.available_models
            .read()
            .await
            .values()
            .cloned()
            .collect()
    }

    /// Get info for a specific model
    pub async fn get_model_info(&self, model_name: &str) -> Option<ModelInfo> {
        self.available_models
            .read()
            .await
            .get(model_name)
            .cloned()
    }

    /// Check if a model is ready to use
    /// If refresh=true, scans filesystem before checking (slower but accurate)
    pub async fn is_model_ready(&self, model_name: &str, refresh: bool) -> bool {
        if refresh {
            if let Err(e) = self.scan_models().await {
                log::error!("Failed to scan models: {}", e);
                return false;
            }
        }

        if let Some(info) = self.get_model_info(model_name).await {
            info.status == ModelStatus::Available
        } else {
            false
        }
    }

    /// Checks `path`, the file of `model_name`, before llama-helper parses it.
    /// Unlike the download, a generation request can meet a file that a
    /// download owns: a partial kept for resume, or one being written. Such a
    /// file is refused and kept. Only a full-size file that fails its hash is
    /// deleted, and the status then shows why, so Settings offers the download.
    pub async fn verify_before_load(
        &self,
        model_name: &str,
        pinned: &'static Pinned,
        path: &Path,
    ) -> Result<()> {
        if self.download_controls.read().await.contains_key(model_name) {
            let name = get_model_by_name(model_name).map_or_else(|| model_name.to_string(), |m| m.display_name);
            return Err(anyhow!("{} is still downloading. Wait for the download to finish in Settings.", name));
        }
        let Err(error) = model_integrity::ensure_verified(pinned, path).await else {
            return Ok(());
        };
        if let Some(IntegrityError::Mismatch { undeleted, .. }) = error.downcast_ref() {
            // A download that started meanwhile owns the status.
            let controls = self.download_controls.read().await;
            if !controls.contains_key(model_name) {
                if let Some(info) = self.available_models.write().await.get_mut(model_name) {
                    info.status = match undeleted {
                        // Gone: the card shows the reason and offers Retry.
                        None => ModelStatus::Error { message: error.to_string() },
                        // Still on disk: offer Retry and Delete, as a scan would.
                        Some(_) => ModelStatus::Corrupted {
                            file_size: pinned.size / (1024 * 1024),
                            expected_min_size: info.size_mb,
                        },
                    };
                }
            }
        }
        Err(error)
    }

    /// Download a model with simple percentage callback (backward compatible)
    pub async fn download_model(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(u8) + Send>>,
    ) -> Result<()> {
        // Wrap the simple callback to use detailed progress internally
        let detailed_callback: Option<Box<dyn Fn(DownloadProgress) + Send>> =
            progress_callback.map(|cb| {
                Box::new(move |p: DownloadProgress| cb(p.percent)) as Box<dyn Fn(DownloadProgress) + Send>
            });
        self.download_model_detailed(model_name, detailed_callback).await
    }

    /// Download a model with detailed progress (MB, speed, etc.)
    pub async fn download_model_detailed(
        &self,
        model_name: &str,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        log::info!("Starting download for model: {}", model_name);

        // Get model definition
        let Some(entry) = model_catalog::entry(Engine::Llama, model_name) else {
            return Err(anyhow!("Unknown model: {}", model_name));
        };
        let Some(model_def) = ModelDef::from_entry(&entry) else {
            return Err(anyhow!("Unknown model: {}", model_name));
        };
        if self.download_controls.read().await.contains_key(model_name) {
            return Err(anyhow!("Download already in progress"));
        }
        // The commit and the file's exact size and SHA-256 there; an
        // unfinished download keeps its own (see installed::plan_download).
        let record_path = installed::record_path_for_file(&self.models_dir.join(&model_def.gguf_file));
        let plan = installed::plan_download(&huggingface::client(), &self.hub, &entry, &record_path).await?;
        let file = &plan.resolved.files[0];
        let install = Install {
            record_path,
            record: installed::InstallRecord::from_resolved(&entry.id, &plan.resolved, false),
            keep_partial: plan.keep_partial,
        };
        self.download_pinned(model_name, &model_def, file.pinned, &file.url, Some(install), huggingface::builder(), progress_callback)
            .await
    }

    /// Downloads `url` as the file `pinned` of `model_def`, with `client` set
    /// up here for large files, and keeps `install`'s record beside it. Tests
    /// pass a local URL, their own pin and no record.
    #[allow(clippy::too_many_arguments)]
    async fn download_pinned(
        &self,
        model_name: &str,
        model_def: &ModelDef,
        pinned: &'static Pinned,
        url: &str,
        install: Option<Install>,
        client: reqwest::ClientBuilder,
        progress_callback: Option<Box<dyn Fn(DownloadProgress) + Send>>,
    ) -> Result<()> {
        // Reserve atomically. A read-then-write check lets two simultaneous UI
        // invokes both pass before either inserts its reservation.
        let control = Arc::new(DownloadControl {
            cancelled: AtomicBool::new(false),
            notify: Notify::new(),
        });
        {
            let mut controls = self.download_controls.write().await;
            if controls.contains_key(model_name) {
                log::warn!("Download already in progress for model: {}", model_name);
                return Err(anyhow!("Download already in progress"));
            }
            controls.insert(model_name.to_string(), control.clone());
        }

        // Update status to downloading
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 0 };
            }
        }

        let file_path = self.models_dir.join(&model_def.gguf_file);

        if let Some(install) = &install {
            // A partial file of another version would only fail the final hash.
            let partial = fs::metadata(&file_path).await.is_ok_and(|metadata| metadata.len() < pinned.size);
            if partial && !install.keep_partial {
                let _ = fs::remove_file(&file_path).await;
            }
            // Before any byte, so an interrupted download resumes from the
            // same commit.
            if let Err(error) = install.write(false) {
                let message = format!("Failed to write the install record of {}: {}", model_name, error);
                self.fail_download(model_name, &control, message.clone()).await;
                return Err(anyhow!(message));
            }
        }

        // Check if model already exists and is valid (skip re-download)
        if file_path.exists() {
            if let Ok(metadata) = fs::metadata(&file_path).await {
                let file_size_mb = metadata.len() / (1024 * 1024);

                // A complete file is hashed once rather than trusted for its
                // size; one that does not match is deleted and downloaded again.
                let verified = metadata.len() == pinned.size
                    && self.validate_gguf_file(&file_path).await.is_ok()
                    && match model_integrity::ensure_verified_cancellable(pinned, &file_path, control.cancel_flag()).await {
                        Ok(()) => true,
                        Err(error) => match error.downcast_ref() {
                            Some(IntegrityError::Cancelled { .. }) => {
                                self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb)
                                    .await;
                                return Err(anyhow!("CANCELLED: Download cancelled by user"));
                            }
                            // The file is still there, so a resume would start
                            // past its end: report why instead.
                            Some(IntegrityError::Mismatch { undeleted: Some(_), .. }) => {
                                self.fail_download(model_name, &control, error.to_string()).await;
                                return Err(error);
                            }
                            _ => {
                                log::warn!("{}; downloading it again", error);
                                false
                            }
                        },
                    };
                if verified {
                    log::info!(
                        "Model '{}' already exists and is valid ({} MB), skipping download",
                        model_name,
                        file_size_mb
                    );

                    let mut controls = self.download_controls.write().await;
                    if control.cancelled.load(Ordering::Acquire) {
                        drop(controls);
                        self.finish_cancelled_download(
                            model_name,
                            &control,
                            &file_path,
                            model_def.size_mb,
                        )
                        .await;
                        return Err(anyhow!("CANCELLED: Download cancelled by user"));
                    }
                    if let Some(install) = &install {
                        if let Err(error) = install.write(true) {
                            drop(controls);
                            let message = format!("Failed to write the install record of {}: {}", model_name, error);
                            self.fail_download(model_name, &control, message.clone()).await;
                            return Err(anyhow!(message));
                        }
                    }
                    let mut models = self.available_models.write().await;
                    if let Some(model_info) = models.get_mut(model_name) {
                        model_info.status = ModelStatus::Available;
                    }
                    controls.remove(model_name);

                    // Report 100% progress
                    if let Some(ref callback) = progress_callback {
                        let total = metadata.len();
                        callback(DownloadProgress::new(total, total, 0.0));
                    }

                    return Ok(());
                } else if metadata.len() >= pinned.size {
                    // File is LARGER than expected - possibly corrupted or wrong file
                    // Delete and re-download in this case
                    log::warn!(
                        "Model '{}' exists but is too large ({} MB, expected exactly {} bytes), deleting and re-downloading",
                        model_name,
                        file_size_mb,
                        pinned.size
                    );
                    // A failed integrity check has already deleted it.
                    if file_path.exists() {
                        if let Err(e) = fs::remove_file(&file_path).await {
                            log::warn!("Failed to delete oversized model file: {}", e);
                        }
                    }
                } else {
                    // File is SMALLER than expected - likely partial download
                    // DON'T DELETE - let resume logic handle it
                    log::info!(
                        "Model '{}' exists but is incomplete ({} MB of approximately {} MB), will resume download",
                        model_name,
                        file_size_mb,
                        model_def.size_mb
                    );
                    // Continue to download/resume logic below
                }
            }
        }

        log::info!("Downloading from: {}", url);
        log::info!("Saving to: {}", file_path.display());

        // Create models directory if needed
        if !self.models_dir.exists() {
            if let Err(error) = fs::create_dir_all(&self.models_dir).await {
                self.fail_download(model_name, &control, format!("Failed to create models directory: {}", error)).await;
                return Err(error.into());
            }
        }

        // Check for existing partial download to resume
        let existing_size: u64 = if file_path.exists() {
            fs::metadata(&file_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };

        // Download the file with optimized client settings
        let client = match client
            .tcp_nodelay(true) // Disable Nagle's algorithm for faster streaming
            .pool_max_idle_per_host(1) // Keep connection alive
            .timeout(Duration::from_secs(3600)) // 1 hour timeout for large files
            .connect_timeout(Duration::from_secs(30))
            .build()
        {
            Ok(client) => client,
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to create HTTP client: {}", error)).await;
                return Err(anyhow!("Failed to create HTTP client: {}", error));
            }
        };

        // Build request with Range header if resuming
        let mut request = client.get(url);
        if existing_size > 0 {
            log::info!(
                "Resuming download from byte {} ({:.1} MB)",
                existing_size,
                existing_size as f64 / (1024.0 * 1024.0)
            );
            request = request.header("Range", format!("bytes={}-", existing_size));
        }

        let response_result = tokio::select! {
            _ = control.notify.notified() => {
                self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
                return Err(anyhow!("CANCELLED: Download cancelled by user"));
            }
            response = request.send() => response,
        };
        let response = match response_result {
            Ok(response) => response,
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to start download: {}", error)).await;
                return Err(anyhow!("Failed to start download: {}", error));
            }
        };

        // Check response status - 200 OK (full download) or 206 Partial Content (resume)
        let (total_size, resuming) = if response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let content_range = response
                .headers()
                .get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            let expected_prefix = format!("bytes {}-", existing_size);
            let expected_total = format!("/{}", pinned.size);
            if !content_range.starts_with(&expected_prefix) || !content_range.ends_with(&expected_total) {
                self.fail_download(
                    model_name,
                    &control,
                    format!("Server returned unexpected resume range: {}", content_range),
                )
                .await;
                return Err(anyhow!("Server returned unexpected resume range: {}", content_range));
            }
            // Server supports resume - total size = existing + remaining
            let remaining = response.content_length().unwrap_or(0);
            log::info!("Server supports resume, {} MB remaining", remaining / (1024 * 1024));
            (existing_size + remaining, true)
        } else if response.status().is_success() {
            // Server doesn't support resume or fresh download
            if existing_size > 0 {
                log::warn!("Server doesn't support resume, starting fresh download");
            }
            let length = response.content_length().unwrap_or(0);
            if length > 0 && length != pinned.size {
                // Nothing has been written yet; a kept partial stays for resume.
                let error = IntegrityError::ServerSize { file: pinned.file, size: length, expected: pinned.size };
                self.fail_download(model_name, &control, error.to_string()).await;
                return Err(error.into());
            }
            (length, false)
        } else {
            self.fail_download(model_name, &control, format!("Download failed with status: {}", response.status())).await;
            return Err(anyhow!("Download failed with status: {}", response.status()));
        };

        log::info!("Total size: {} MB", total_size / (1024 * 1024));

        // The hash covers the whole file, so a resumed transfer first reads back
        // the bytes it keeps.
        let mut integrity = if resuming {
            match model_integrity::Check::resume(pinned, &file_path, control.cancel_flag()).await {
                Ok(check) => check,
                Err(error) if matches!(error.downcast_ref(), Some(IntegrityError::Cancelled { .. })) => {
                    // The partial file is untouched and stays for the next resume.
                    self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
                    return Err(anyhow!("CANCELLED: Download cancelled by user"));
                }
                Err(error) => {
                    self.fail_download(model_name, &control, format!("Failed to read partial model file: {}", error)).await;
                    return Err(anyhow!("Failed to read partial model file: {}", error));
                }
            }
        } else {
            model_integrity::Check::new(pinned)
        };
        // The file is about to change; an old marker must not outlive it.
        model_integrity::clear_mark(&file_path);

        // Open file for append if resuming, or create new
        let file_result = if resuming {
            OpenOptions::new()
                .write(true)
                .append(true)
                .open(&file_path)
                .await
        } else {
            fs::File::create(&file_path).await
        };
        let file = match file_result {
            Ok(file) => file,
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to open model file: {}", error)).await;
                return Err(anyhow!("Failed to open model file: {}", error));
            }
        };

        // Use 8MB buffer to reduce disk I/O syscalls (major performance improvement)
        let mut writer = BufWriter::with_capacity(8 * 1024 * 1024, file);

        let mut downloaded: u64 = if resuming { existing_size } else { 0 };

        // Emit initial progress (showing resumed position if applicable)
        if let Some(ref callback) = progress_callback {
            callback(DownloadProgress::new(downloaded, total_size, 0.0));
        }
        log::info!(
            "Starting at {:.1} MB / {:.1} MB",
            downloaded as f64 / (1024.0 * 1024.0),
            total_size as f64 / (1024.0 * 1024.0)
        );

        let mut last_progress_percent = if total_size > 0 {
            ((downloaded as f64 / total_size as f64) * 100.0) as u8
        } else {
            0
        };
        let mut last_report_time = std::time::Instant::now();
        let mut bytes_since_last_report: u64 = 0;
        let download_start_time = std::time::Instant::now();
        let start_downloaded = downloaded;

        use futures_util::StreamExt;
        let mut stream = response.bytes_stream();

        loop {
            // Check for cancellation
            {
                if control.cancelled.load(Ordering::Acquire) {
                    log::info!("Download cancelled for model: {}", model_name);

                    // Flush and keep partial file for resume on next attempt
                    let _ = writer.flush().await;
                    drop(writer);

                    self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;

                    // Use special marker prefix to distinguish cancellation from other errors
                    return Err(anyhow!("CANCELLED: Download cancelled by user"));
                }
            }

            // Add per-chunk timeout (30 seconds) to detect stalled connections
            let next_result = tokio::select! {
                _ = control.notify.notified() => continue,
                result = timeout(Duration::from_secs(30), stream.next()) => result,
            };

            let chunk = match next_result {
                // Timeout - no data received for 30 seconds
                Err(_) => {
                    log::warn!("Download timeout for {}: no data received for 30 seconds", model_name);
                    let _ = writer.flush().await;

                    self.fail_download(model_name, &control, "Download timeout - No data received for 30 seconds".to_string()).await;

                    return Err(anyhow!("Download timeout - No data received for 30 seconds"));
                },
                // Stream ended
                Ok(None) => break,
                // Got chunk result
                Ok(Some(chunk_result)) => {
                    match chunk_result {
                        Ok(c) => c,
                        // Detect error type for better user feedback
                        Err(e) => {
                            log::error!("Download error for {}: {:?}", model_name, e);
                            let _ = writer.flush().await;

                            // Categorize error for user-friendly message
                            let error_msg = if e.is_timeout() {
                                "Connection timeout - Check your internet"
                            } else if e.is_connect() {
                                "Connection failed - Check your internet"
                            } else if e.is_body() {
                                "Stream interrupted - Network unstable"
                            } else {
                                "Download error"
                            };

                            self.fail_download(model_name, &control, error_msg.to_string()).await;

                            return Err(anyhow!("{}: {}", error_msg, e));
                        }
                    }
                }
            };
            let chunk_len = chunk.len() as u64;
            if let Err(error) = integrity.update(&chunk) {
                drop(writer);
                let _ = fs::remove_file(&file_path).await;
                self.fail_download(model_name, &control, error.to_string()).await;
                return Err(error);
            }
            if let Err(error) = writer.write_all(&chunk).await {
                self.fail_download(model_name, &control, format!("Error writing model file: {}", error)).await;
                return Err(anyhow!("Error writing to file: {}", error));
            }

            downloaded += chunk_len;
            bytes_since_last_report += chunk_len;

            // Calculate progress. It stops at 99% here: 100% is reported only
            // once the file has matched its pin, below.
            let progress_percent = if total_size > 0 {
                let exact_percent = (downloaded as f64 / total_size as f64) * 100.0;
                exact_percent.min(99.0) as u8
            } else {
                0
            };

            let elapsed_since_report = last_report_time.elapsed();
            let is_download_complete = downloaded >= total_size;
            let should_report = progress_percent > last_progress_percent
                || is_download_complete  // Force a report of the last bytes
                || elapsed_since_report.as_millis() >= 500;

            if should_report {
                // Calculate speed based on bytes downloaded since last report
                let speed_mbps = if elapsed_since_report.as_secs_f64() > 0.0 {
                    (bytes_since_last_report as f64 / (1024.0 * 1024.0)) / elapsed_since_report.as_secs_f64()
                } else {
                    // Fallback to overall average speed
                    let total_elapsed = download_start_time.elapsed().as_secs_f64();
                    if total_elapsed > 0.0 {
                        ((downloaded - start_downloaded) as f64 / (1024.0 * 1024.0)) / total_elapsed
                    } else {
                        0.0
                    }
                };

                log::info!(
                    "Download: {:.1} MB / {:.1} MB ({:.1} MB/s)",
                    downloaded as f64 / (1024.0 * 1024.0),
                    total_size as f64 / (1024.0 * 1024.0),
                    speed_mbps
                );

                // Update status
                {
                    let mut models = self.available_models.write().await;
                    if let Some(model_info) = models.get_mut(model_name) {
                        model_info.status = ModelStatus::Downloading { progress: progress_percent };
                    }
                }

                // Call progress callback with detailed info
                if let Some(ref callback) = progress_callback {
                    callback(DownloadProgress {
                        percent: progress_percent,
                        ..DownloadProgress::new(downloaded, total_size, speed_mbps)
                    });
                }

                last_progress_percent = progress_percent;
                last_report_time = std::time::Instant::now();
                bytes_since_last_report = 0;
            }
        }

        if let Err(error) = writer.flush().await {
            self.fail_download(model_name, &control, format!("Failed to flush model file: {}", error)).await;
            return Err(error.into());
        }
        drop(writer);

        let final_size = match fs::metadata(&file_path).await {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                self.fail_download(model_name, &control, format!("Failed to inspect downloaded model: {}", error)).await;
                return Err(error.into());
            }
        };
        if final_size != pinned.size || (total_size > 0 && final_size != total_size) {
            let final_size_mb = final_size / (1024 * 1024);
            log::warn!(
                "Download ended before model '{}' was complete: {} MB of approximately {} MB",
                model_name,
                final_size_mb,
                model_def.size_mb
            );
            {
                let mut models = self.available_models.write().await;
                if let Some(model_info) = models.get_mut(model_name) {
                    model_info.status = ModelStatus::Incomplete {
                        file_size: final_size_mb,
                        expected_size: model_def.size_mb,
                    };
                }
            }
            self.release_download(model_name, &control).await;
            return Err(anyhow!(
                "Download incomplete: received {} MB of approximately {} MB; retry to resume",
                final_size_mb,
                model_def.size_mb
            ));
        }

        if control.cancelled.load(Ordering::Acquire) {
            self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
            return Err(anyhow!("CANCELLED: Download cancelled by user"));
        }

        if let Err(e) = self.validate_gguf_file(&file_path).await {
            log::error!("Downloaded file failed validation: {}", e);

            // Clean up invalid file
            let _ = fs::remove_file(&file_path).await;

            // Update status
            {
                let mut models = self.available_models.write().await;
                if let Some(model_info) = models.get_mut(model_name) {
                    model_info.status = ModelStatus::Error {
                        message: format!("Validation failed: {}", e),
                    };
                }
            }

            self.release_download(model_name, &control).await;

            return Err(anyhow!("File validation failed: {}", e));
        }

        // The right format is not the right file: compare the streamed SHA-256
        // with the pin. A mismatch has deleted the file.
        if let Err(error) = integrity.finish(&file_path) {
            log::error!("{}", error);
            self.fail_download(model_name, &control, error.to_string()).await;
            return Err(error);
        }
        model_integrity::mark_verified(pinned, &file_path);
        if let Some(install) = &install {
            if let Err(error) = install.write(true) {
                let message = format!("Failed to write the install record of {}: {}", model_name, error);
                self.fail_download(model_name, &control, message.clone()).await;
                return Err(anyhow!(message));
            }
        }

        // Completion and 100% are reported only now that the file matched.
        log::info!("Download completed for model: {}", model_name);

        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::Downloading { progress: 100 };
            }
        }

        if let Some(ref callback) = progress_callback {
            callback(DownloadProgress::new(final_size, final_size, 0.0));
        }

        // Commit completion while ownership is still held. Cancellation is
        // either observed here or rejected after the control is removed.
        let mut controls = self.download_controls.write().await;
        if control.cancelled.load(Ordering::Acquire) {
            drop(controls);
            self.finish_cancelled_download(model_name, &control, &file_path, model_def.size_mb).await;
            return Err(anyhow!("CANCELLED: Download cancelled by user"));
        }
        let mut models = self.available_models.write().await;
        if let Some(model_info) = models.get_mut(model_name) {
            model_info.status = ModelStatus::Available;
            model_info.path = file_path.clone();
        }
        controls.remove(model_name);

        Ok(())
    }

    /// Validate that a file is a valid GGUF model
    async fn validate_gguf_file(&self, path: &PathBuf) -> Result<()> {
        let mut file = fs::File::open(path).await?;

        // Read first 4 bytes to check for GGUF magic number
        use tokio::io::AsyncReadExt;
        let mut magic = [0u8; 4];
        file.read_exact(&mut magic).await?;

        // GGUF magic number is "GGUF" (0x47475546)
        if &magic == b"GGUF" {
            Ok(())
        } else if &magic == b"ggjt" || &magic == b"ggla" || &magic == b"ggml" {
            // Older formats (GGML, GGJT)
            Ok(())
        } else {
            Err(anyhow!(
                "Invalid model file: magic number {:?} doesn't match GGUF/GGML",
                magic
            ))
        }
    }

    async fn release_download(&self, model_name: &str, control: &Arc<DownloadControl>) {
        let mut controls = self.download_controls.write().await;
        if controls
            .get(model_name)
            .is_some_and(|current| Arc::ptr_eq(current, control))
        {
            controls.remove(model_name);
        }
    }

    async fn fail_download(
        &self,
        model_name: &str,
        control: &Arc<DownloadControl>,
        message: String,
    ) {
        let mut models = self.available_models.write().await;
        if let Some(model_info) = models.get_mut(model_name) {
            model_info.status = ModelStatus::Error { message };
        }
        drop(models);
        self.release_download(model_name, control).await;
    }

    async fn finish_cancelled_download(
        &self,
        model_name: &str,
        control: &Arc<DownloadControl>,
        file_path: &PathBuf,
        expected_size: u64,
    ) {
        let partial_size = fs::metadata(file_path).await.map(|m| m.len()).unwrap_or(0);
        let mut models = self.available_models.write().await;
        if let Some(model_info) = models.get_mut(model_name) {
            model_info.status = if partial_size > 0 {
                ModelStatus::Incomplete {
                    file_size: partial_size / (1024 * 1024),
                    expected_size,
                }
            } else {
                ModelStatus::NotDownloaded
            };
        }
        drop(models);
        self.release_download(model_name, control).await;
    }

    /// Cancel an ongoing download
    pub async fn cancel_download(&self, model_name: &str) -> Result<()> {
        log::info!("Cancelling download for model: {}", model_name);

        let control = self
            .download_controls
            .read()
            .await
            .get(model_name)
            .cloned()
            .ok_or_else(|| anyhow!("No download in progress for model: {}", model_name))?;
        control.cancelled.store(true, Ordering::Release);
        control.notify.notify_one();

        timeout(Duration::from_secs(5), async {
            while self
                .download_controls
                .read()
                .await
                .get(model_name)
                .is_some_and(|current| Arc::ptr_eq(current, &control))
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .map_err(|_| anyhow!("Timed out cancelling model download"))?;

        Ok(())
    }

    /// Delete a corrupted or available model file
    pub async fn delete_model(&self, model_name: &str) -> Result<()> {
        log::info!("Deleting model: {}", model_name);

        let model_def = get_model_by_name(model_name)
            .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;

        let file_path = self.models_dir.join(&model_def.gguf_file);

        if file_path.exists() {
            fs::remove_file(&file_path).await?;
            log::info!("Deleted model file: {}", file_path.display());
        }
        model_integrity::clear_mark(&file_path);
        installed::remove_record(&installed::record_path_for_file(&file_path));

        // Update status
        {
            let mut models = self.available_models.write().await;
            if let Some(model_info) = models.get_mut(model_name) {
                model_info.status = ModelStatus::NotDownloaded;
            }
        }

        Ok(())
    }

    /// Get models directory path
    pub fn get_models_directory(&self) -> PathBuf {
        self.models_dir.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The 0.3.0 size of `name`, which a 0.3.x install is checked against.
    fn legacy_size(name: &str) -> u64 {
        installed::legacy_model(Engine::Llama, name).unwrap().files[0].size
    }

    #[tokio::test]
    async fn scan_marks_partial_model_incomplete_and_exact_model_available() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ModelManager::new_with_models_dir(Some(temp.path().to_path_buf()))
            .expect("manager");
        let model = get_model_by_name("qwen3.5:2b").expect("model");
        let size = legacy_size(&model.name);
        let path = temp.path().join(&model.gguf_file);

        let partial = fs::File::create(&path).await.expect("partial file");
        partial.set_len(123_456).await.expect("partial size");
        manager.init().await.expect("partial scan");
        assert!(matches!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Incomplete { .. }
        ));

        let mut exact = fs::OpenOptions::new().write(true).open(&path).await.expect("exact file");
        exact.set_len(size).await.expect("exact invalid size");
        manager.scan_models().await.expect("invalid exact scan");
        assert!(matches!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Corrupted { .. }
        ));

        exact.write_all(b"GGUF").await.expect("GGUF magic");
        exact.set_len(size).await.expect("exact size");
        manager.scan_models().await.expect("exact scan");
        assert_eq!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Available
        );
    }

    /// Stands in for a GGUF pin, so a test hashes bytes rather than gigabytes.
    fn small_pin(content: &[u8]) -> &'static Pinned {
        model_integrity::testing::pin_of("model.gguf", content)
    }

    /// Downloads `body` from a local server as the file of `pinned`, for the
    /// model `qwen3.5:2b`. Each progress report comes with whether the file
    /// had been marked verified by then.
    async fn download_locally(
        manager: &ModelManager,
        pinned: &'static Pinned,
        body: Vec<u8>,
    ) -> (Result<()>, Vec<(u8, bool)>) {
        let mut model = get_model_by_name("qwen3.5:2b").expect("model");
        model.gguf_file = pinned.file.to_string();
        let url = model_integrity::testing::serve_once(body).await;
        let marker = manager.models_dir.join(format!("{}.verified", pinned.file));
        let reports = Arc::new(std::sync::Mutex::new(Vec::new()));
        let callback: Box<dyn Fn(DownloadProgress) + Send> = {
            let reports = reports.clone();
            Box::new(move |progress| reports.lock().unwrap().push((progress.percent, marker.exists())))
        };
        let client = reqwest::Client::builder().no_proxy();
        let result = manager.download_pinned(&model.name, &model, pinned, &url, None, client, Some(callback)).await;
        let reports = reports.lock().unwrap().clone();
        (result, reports)
    }

    #[tokio::test]
    async fn a_download_reports_100_percent_only_after_the_file_matched() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ModelManager::new_with_models_dir(Some(temp.path().to_path_buf())).unwrap();
        manager.init().await.unwrap();
        let mut body = b"GGUF".to_vec();
        body.extend((0..300_000u32).map(|i| (i % 251) as u8));

        let (result, reports) = download_locally(&manager, small_pin(&body), body).await;
        result.unwrap();
        // The stream's reports stay below 100%; the only 100% follows the marker.
        let (last, streamed) = reports.split_last().unwrap();
        assert_eq!(*last, (100, true), "{reports:?}");
        assert!(streamed.iter().all(|&(percent, _)| percent < 100), "{reports:?}");
        assert_eq!(manager.get_model_info("qwen3.5:2b").await.unwrap().status, ModelStatus::Available);
    }

    #[tokio::test]
    async fn a_download_that_fails_its_check_never_reports_100_percent() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ModelManager::new_with_models_dir(Some(temp.path().to_path_buf())).unwrap();
        manager.init().await.unwrap();
        let mut body = b"GGUF".to_vec();
        body.resize(300_000, 7);
        // The pinned size, other content.
        let mut pinned_content = body.clone();
        pinned_content[150_000] = 8;

        let (result, reports) = download_locally(&manager, small_pin(&pinned_content), body).await;
        let error = result.unwrap_err().to_string();
        assert!(error.contains("failed its integrity check and was deleted"), "{error}");
        assert!(!temp.path().join("model.gguf").exists());
        assert!(!reports.is_empty(), "the stream reported no progress");
        assert!(reports.iter().all(|&(percent, _)| percent < 100), "{reports:?}");
        assert!(matches!(
            manager.get_model_info("qwen3.5:2b").await.unwrap().status,
            ModelStatus::Error { .. }
        ));
    }

    async fn start_download(manager: &ModelManager, model_name: &str) -> Arc<DownloadControl> {
        let control = Arc::new(DownloadControl { cancelled: AtomicBool::new(false), notify: Notify::new() });
        manager.download_controls.write().await.insert(model_name.to_string(), control.clone());
        control
    }

    #[test]
    fn every_status_serializes_with_its_tag_and_round_trips() {
        use serde_json::json;
        let statuses = [
            (ModelStatus::NotDownloaded, json!({ "type": "not_downloaded" })),
            (ModelStatus::Downloading { progress: 42 }, json!({ "type": "downloading", "progress": 42 })),
            (ModelStatus::Available, json!({ "type": "available" })),
            (
                ModelStatus::Incomplete { file_size: 1, expected_size: 2 },
                json!({ "type": "incomplete", "file_size": 1, "expected_size": 2 }),
            ),
            (
                ModelStatus::Corrupted { file_size: 3, expected_min_size: 4 },
                json!({ "type": "corrupted", "file_size": 3, "expected_min_size": 4 }),
            ),
            (
                ModelStatus::Error { message: "Download timeout".to_string() },
                json!({ "type": "error", "message": "Download timeout" }),
            ),
        ];
        for (status, expected) in statuses {
            // Exhaustive, so a new variant fails to compile until it is listed.
            match status {
                ModelStatus::NotDownloaded
                | ModelStatus::Downloading { .. }
                | ModelStatus::Available
                | ModelStatus::Incomplete { .. }
                | ModelStatus::Corrupted { .. }
                | ModelStatus::Error { .. } => {}
            }
            assert_eq!(serde_json::to_value(&status).expect("serializes"), expected);
            assert_eq!(serde_json::from_value::<ModelStatus>(expected).expect("deserializes"), status);
        }
    }

    /// `builtin_ai_list_models` returns the cached statuses without a rescan,
    /// so the Error a failed download leaves must reach Settings.
    #[tokio::test]
    async fn the_model_list_serializes_after_a_failed_download() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ModelManager::new_with_models_dir(Some(temp.path().to_path_buf())).unwrap();
        manager.init().await.unwrap();
        let model = get_model_by_name("qwen3.5:2b").expect("model");
        let control = start_download(&manager, &model.name).await;

        let message = "Download timeout - No data received for 30 seconds";
        manager.fail_download(&model.name, &control, message.to_string()).await;

        assert!(manager.download_controls.read().await.is_empty());
        let listed = serde_json::to_value(manager.list_models().await).expect("Settings can list the models");
        let failed = listed.as_array().unwrap().iter().find(|info| info["name"] == model.name).unwrap();
        assert_eq!(failed["status"], serde_json::json!({ "type": "error", "message": message }));
    }

    /// The live assistant, person and group questions call `generate_with_builtin`
    /// with no readiness check; it must leave a download's file alone.
    #[tokio::test]
    async fn the_live_assistant_keeps_a_partial_or_downloading_model() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let data_dir = temp.path().to_path_buf();
        let models_dir = super::super::models::get_models_directory(&data_dir);
        std::fs::create_dir_all(&models_dir).unwrap();
        let manager = Arc::new(ModelManager::new_with_models_dir(Some(models_dir.clone())).unwrap());
        manager.init().await.unwrap();
        manager.register();
        let model = get_model_by_name("qwen3.5:2b").expect("model");
        let path = models_dir.join(&model.gguf_file);
        // A download cancelled part-way and kept for resume.
        std::fs::File::create(&path).unwrap().set_len(123_456).unwrap();

        let ask = || super::super::client::generate_with_builtin(&data_dir, &model.name, "system", "question", None);
        let error = ask().await.unwrap_err().to_string();
        assert!(error.contains("is not fully downloaded: it has 123456 of"), "{error}");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 123_456);

        start_download(&manager, &model.name).await;
        let error = ask().await.unwrap_err().to_string();
        assert!(error.contains("is still downloading"), "{error}");
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 123_456);
    }

    #[tokio::test]
    async fn a_full_size_model_that_fails_its_hash_is_deleted_and_offered_again() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = ModelManager::new_with_models_dir(Some(temp.path().to_path_buf())).unwrap();
        let model = get_model_by_name("qwen3.5:2b").expect("model");
        let pinned = small_pin(b"GGUF model");
        let path = temp.path().join(&model.gguf_file);
        std::fs::write(&path, b"GGUF modeL").unwrap();
        manager.init().await.unwrap();
        manager.available_models.write().await.get_mut(&model.name).unwrap().status = ModelStatus::Available;

        // While a download owns the file, even a full-size one is left alone.
        start_download(&manager, &model.name).await;
        let error = manager.verify_before_load(&model.name, pinned, &path).await.unwrap_err();
        assert!(error.to_string().contains("is still downloading"), "{error}");
        assert!(path.exists());
        manager.download_controls.write().await.clear();

        let error = manager.verify_before_load(&model.name, pinned, &path).await.unwrap_err();
        assert!(error.to_string().contains("failed its integrity check and was deleted"), "{error}");
        assert!(!path.exists());
        // Settings lists the cached status, which now says why and offers Retry.
        assert_eq!(
            manager.get_model_info(&model.name).await.unwrap().status,
            ModelStatus::Error { message: error.to_string() }
        );
        serde_json::to_string(&manager.list_models().await).expect("statuses reach the UI");

        std::fs::write(&path, b"GGUF model").unwrap();
        manager.verify_before_load(&model.name, pinned, &path).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_stops_hashing_a_kept_model_at_once() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let temp = tempfile::tempdir().expect("tempdir");
        let manager = Arc::new(ModelManager::new_with_models_dir(Some(temp.path().to_path_buf())).unwrap());
        manager.init().await.unwrap();
        let model = get_model_by_name("qwen3.5:2b").expect("model");
        let path = temp.path().join(&model.gguf_file);
        // A complete file left by an older build, never verified: 1.2 GB to
        // hash before the download would move on (and fail: it is zeros).
        let mut file = std::fs::File::create(&path).unwrap();
        std::io::Write::write_all(&mut file, b"GGUF").unwrap();
        file.set_len(legacy_size(&model.name)).unwrap();
        drop(file);
        // An unfinished download of the 0.3.0 commit, so the download plans
        // without asking Hugging Face and the test stays offline.
        let legacy = installed::legacy_model(Engine::Llama, &model.name).unwrap();
        let record = installed::InstallRecord {
            id: model.name.clone(),
            repo: legacy.repo.to_string(),
            commit: legacy.commit.to_string(),
            complete: false,
            files: vec![installed::RecordFile {
                name: legacy.files[0].file.to_string(),
                size: legacy.files[0].size,
                sha256: legacy.files[0].sha256.to_string(),
                git_oid: None,
            }],
        };
        installed::write_record(&installed::record_path_for_file(&path), &record).unwrap();

        let download = tokio::spawn({
            let manager = manager.clone();
            let name = model.name.clone();
            async move { manager.download_model_detailed(&name, None).await }
        });
        while !matches!(manager.get_model_info(&model.name).await.unwrap().status, ModelStatus::Downloading { .. }) {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        let started = std::time::Instant::now();
        // Fails with "Timed out cancelling model download" after 5 s.
        manager.cancel_download(&model.name).await.unwrap();
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        let error = download.await.unwrap().unwrap_err().to_string();
        assert!(error.starts_with("CANCELLED:"), "{error}");
        // Neither deleted as a mismatch nor marked as verified.
        assert_eq!(std::fs::metadata(&path).unwrap().len(), legacy_size(&model.name));
        assert!(!temp.path().join(format!("{}.verified", model.gguf_file)).exists());
    }
}
