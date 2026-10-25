//! One-click download of local speaker-diarization models.
//!
//! Supports both:
//! - Pyannote pipeline (segmentation-3.0 + WeSpeaker + VBx): a repair download of
//!   the copies bundled with the app, from this repository at a pinned commit
//! - NVIDIA Nemotron-3 model and license, pinned by revision, length and SHA-256.
//!
//! Sources, sizes and hashes live in `crate::model_integrity`. Each file is
//! streamed to a `.part` temporary, verified, then atomically renamed into
//! place — a partial or corrupt download can never be mistaken for a valid model.
//!
//! Progress is reported to the UI via `diarization-download-progress` events.

use crate::model_integrity::{self, Pinned, NEMOTRON, PYANNOTE, PYANNOTE_BASE};
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter, Runtime};

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    /// File currently being handled.
    pub file: String,
    /// 1-based index of that file.
    pub file_index: usize,
    pub file_count: usize,
    /// Bytes fetched for the current file.
    pub downloaded: u64,
    /// Expected size of the current file.
    pub total: u64,
    /// Overall progress across all files, 0–100.
    pub percent: f32,
    /// "downloading" | "verifying" | "skipped" | "done" | "error"
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn emit<R: Runtime>(app: &AppHandle<R>, p: DownloadProgress) {
    let _ = app.emit("diarization-download-progress", p);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_ipc_future_stays_within_windows_stack_budget() {
        fn future_size<F: std::future::Future>(
            _: impl FnOnce(tauri::AppHandle<tauri::Wry>, Option<String>) -> F,
        ) -> usize {
            std::mem::size_of::<F>()
        }
        // Inspect the actual command future without constructing/running a GUI.
        let size = future_size(super::super::download_diarization_models::<tauri::Wry>);
        assert!(size < 32 * 1024, "Download IPC future is {size} bytes; nested Tauri dispatch can overflow the Windows stack");
        println!("Download IPC future: {size} bytes");
    }

    #[tokio::test]
    async fn checksum_future_is_small_and_hashes_multiple_buffers() {
        use sha2::{Digest, Sha256};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.onnx");
        // Larger than the 1 MiB read buffer, so the hash spans several reads.
        let bytes: Vec<u8> = (0..2_500_003).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&path, &bytes).await.unwrap();
        let pinned: &'static Pinned = Box::leak(Box::new(Pinned {
            file: "model.onnx",
            size: bytes.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(&bytes)).into_boxed_str()),
        }));
        let future = model_integrity::verify_file(pinned, &path);
        // Windows IPC can copy/nest this future several times before spawning it.
        // Prevent the 64 KiB inline buffer that caused _alloca_probe stack overflow.
        assert!(std::mem::size_of_val(&future) < 4096, "Checksum buffer leaked onto async stack");
        future.await.unwrap();
    }

    #[test]
    fn nemotron_download_pins_match_the_loader() {
        let model = model_integrity::NEMOTRON
            .iter()
            .map(|(_, pinned)| pinned)
            .find(|pinned| pinned.file == super::super::nemotron::NEMOTRON_MODEL_FILENAME)
            .unwrap();
        assert_eq!(model.size, super::super::nemotron::NEMOTRON_EXPECTED_BYTES);
        assert_eq!(model.sha256, super::super::nemotron::NEMOTRON_SHA256);
    }
}

/// Download Pyannote models.
pub async fn download_pyannote_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let dir = super::diarization_user_model_dir();
    tokio::fs::create_dir_all(&dir).await?;

    let total_bytes: u64 = PYANNOTE.iter().map(|pinned| pinned.size).sum();
    let mut completed_bytes: u64 = 0;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(1800))
        .build()?;

    for (index, pinned) in PYANNOTE.iter().enumerate() {
        let name = pinned.file;
        let dest = dir.join(name);
        let file_index = index + 1;

        if dest.exists() {
            // A copy that does not match is deleted by the check.
            if model_integrity::verify_file(pinned, &dest).await.is_ok() {
                completed_bytes += pinned.size;
                log::info!("✅ {} already present and verified", name);
                emit(
                    app,
                    DownloadProgress {
                        file: name.to_string(),
                        file_index,
                        file_count: PYANNOTE.len(),
                        downloaded: pinned.size,
                        total: pinned.size,
                        percent: (completed_bytes as f32 / total_bytes as f32) * 100.0,
                        status: "skipped".into(),
                        message: Some("Already installed".into()),
                    },
                );
                continue;
            }
            log::warn!("{} present but failed verification — re-downloading", name);
            let _ = tokio::fs::remove_file(&dest).await;
        }

        let url = format!("{}/{}", PYANNOTE_BASE, name);
        log::info!("⬇️ Downloading {} …", name);

        download_single_file(app, &client, &url, &dest, pinned, file_index, PYANNOTE.len(), completed_bytes, total_bytes).await?;
        completed_bytes += pinned.size;
    }

    emit(
        app,
        DownloadProgress {
            file: String::new(),
            file_index: PYANNOTE.len(),
            file_count: PYANNOTE.len(),
            downloaded: total_bytes,
            total: total_bytes,
            percent: 100.0,
            status: "done".into(),
            message: Some("All pyannote diarization models installed".into()),
        },
    );

    Ok(())
}

/// Download the pinned NVIDIA Nemotron-3 ONNX export and its model license.
pub async fn download_nemotron_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let dir = super::diarization_user_model_dir();
    tokio::fs::create_dir_all(&dir).await?;

    let total_bytes: u64 = NEMOTRON.iter().map(|(_, pinned)| pinned.size).sum();
    let mut completed_bytes: u64 = 0;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()?;

    for (index, (url, pinned)) in NEMOTRON.iter().enumerate() {
        let name = pinned.file;
        let dest = dir.join(name);
        let file_index = index + 1;

        // Only an exact length and checksum can identify a completed artifact;
        // a copy that does not match is deleted by the check.
        if dest.exists() && model_integrity::verify_file(pinned, &dest).await.is_ok() {
            completed_bytes += pinned.size;
            log::info!("✅ {} already present and verified by SHA-256", name);
            emit(
                app,
                DownloadProgress {
                    file: name.to_string(),
                    file_index,
                    file_count: NEMOTRON.len(),
                    downloaded: pinned.size,
                    total: pinned.size,
                    percent: (completed_bytes as f32 / total_bytes as f32) * 100.0,
                    status: "skipped".into(),
                    message: Some("Already installed".into()),
                },
            );
            continue;
        }
        let _ = tokio::fs::remove_file(&dest).await;

        log::info!("⬇️ Downloading {} from {} …", name, url);
        download_single_file(app, &client, url, &dest, pinned, file_index, NEMOTRON.len(), completed_bytes, total_bytes).await?;
        completed_bytes += pinned.size;
    }

    emit(
        app,
        DownloadProgress {
            file: String::new(),
            file_index: NEMOTRON.len(),
            file_count: NEMOTRON.len(),
            downloaded: total_bytes,
            total: total_bytes,
            percent: 100.0,
            status: "done".into(),
            message: Some("Nemotron-3 Diarization model installed successfully".into()),
        },
    );

    Ok(())
}

async fn download_single_file<R: Runtime>(
    app: &AppHandle<R>,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    pinned: &'static Pinned,
    file_index: usize,
    file_count: usize,
    completed_bytes: u64,
    total_bytes: u64,
) -> Result<()> {
    let name = pinned.file;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| anyhow!("Failed to start download for {}: {}", name, e))?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Download of {} failed with status {}",
            name,
            response.status()
        ));
    }
    let content_len = response.content_length().unwrap_or(pinned.size);

    let part = dest.with_file_name(format!("{name}.part"));
    let mut file = tokio::fs::File::create(&part).await?;
    let mut check = model_integrity::Check::new(pinned);
    let mut written: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| anyhow!("Download of {} interrupted: {}", name, e))?;
        if let Err(error) = check.update(&chunk) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(error);
        }
        {
            use tokio::io::AsyncWriteExt;
            file.write_all(&chunk).await?;
        }
        written += chunk.len() as u64;

        if last_emit.elapsed().as_millis() >= 100 {
            last_emit = std::time::Instant::now();
            let overall = ((completed_bytes + written) as f32 / total_bytes as f32) * 100.0;
            emit(
                app,
                DownloadProgress {
                    file: name.to_string(),
                    file_index,
                    file_count,
                    downloaded: written,
                    total: content_len,
                    percent: overall.min(100.0),
                    status: "downloading".into(),
                    message: None,
                },
            );
        }
    }

    {
        use tokio::io::AsyncWriteExt;
        file.flush().await?;
    }
    drop(file);

    emit(
        app,
        DownloadProgress {
            file: name.to_string(),
            file_index,
            file_count,
            downloaded: written,
            total: content_len,
            percent: ((completed_bytes + written) as f32 / total_bytes as f32) * 100.0,
            status: "verifying".into(),
            message: None,
        },
    );
    // A truncated or different file fails here and its `.part` is deleted.
    check.finish(&part)?;

    tokio::fs::rename(&part, dest).await?;
    log::info!("✅ {} downloaded and verified", name);
    Ok(())
}

/// Download diarization models (delegates according to engine or active).
pub async fn download_models<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    let engine = super::get_active_engine();
    if engine.eq_ignore_ascii_case("nemotron") {
        download_nemotron_models(app).await
    } else {
        download_pyannote_models(app).await
    }
}

pub async fn download_models_for_engine<R: Runtime>(app: &AppHandle<R>, engine: &str) -> Result<()> {
    if engine.eq_ignore_ascii_case("nemotron") {
        download_nemotron_models(app).await
    } else {
        download_pyannote_models(app).await
    }
}

/// Total download size in bytes for Pyannote models.
pub fn total_download_bytes() -> u64 {
    PYANNOTE.iter().map(|pinned| pinned.size).sum()
}

/// Total download size in bytes for Nemotron models.
pub fn nemotron_download_bytes() -> u64 {
    NEMOTRON.iter().map(|(_, pinned)| pinned.size).sum()
}
