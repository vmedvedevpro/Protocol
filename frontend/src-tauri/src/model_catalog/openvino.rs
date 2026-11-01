//! OpenVINO companions of Whisper models (#79): an OpenVINO IR export of a
//! Whisper model, which the engine runs on an Intel GPU in place of the ggml
//! file (`whisper_engine::openvino`).
//!
//! A companion is an `openvino-ir` catalog entry naming the ggml models it
//! serves (`companion_of`). It is never a model of its own: the Whisper list
//! leaves it out (`super::usable`), and Settings offers it beside the model it
//! serves, with what it is, its size and why, so nothing is downloaded
//! without the person asking.
//!
//! On disk a companion is `<models>/openvino/<id>/` with its `install.json`
//! and a `.verified` marker beside each file. The download takes the same
//! steps as a Parakeet model's: the files are resolved at the entry's pinned
//! commit, the record is written incomplete before the first byte (so an
//! interrupted download resumes from that commit), every file is hashed as it
//! streams in against its pin and marked, and the record says complete only
//! once all of them matched. [`installed_companion`] trusts exactly that state.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::installed::{self, InstallRecord};
use super::schema::Entry;
use super::{huggingface, sizes};
use crate::model_integrity::{self, Pinned};
use crate::updater::busy::{self, BusyReason};

/// Sent when a companion's state changes (a download's progress, its end, a
/// deletion, a size read from Hugging Face); Settings asks for the status
/// again.
pub const CHANGED_EVENT: &str = "openvino-companion-changed";

pub const CANCELLED: &str = "The download was cancelled";

/// How often a running download reports its progress.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);

/// A stalled transfer fails after this long without a byte, like the other
/// model downloads.
const STALL: Duration = Duration::from_secs(30);

/// The companion that serves the Whisper model `whisper_model_id`, if the
/// catalog has one this build can run.
pub fn companion_for(whisper_model_id: &str) -> Option<Entry> {
    super::companions()
        .into_iter()
        .find(|entry| entry.companion_of.iter().any(|id| id == whisper_model_id))
}

fn companion(id: &str) -> Option<Entry> {
    super::companions().into_iter().find(|entry| entry.id == id)
}

/// Where the companion `entry` is kept under `models_dir`.
pub fn dir_in(models_dir: &Path, entry: &Entry) -> PathBuf {
    models_dir.join("openvino").join(&entry.id)
}

/// The companion's folder when its download completed and every file still
/// has a valid verification marker: two metadata reads and a small file read
/// per file, no hashing. A file changed since its check loses its marker and
/// the companion then counts as not installed until a download checks it
/// again (which re-hashes the file instead of fetching it anew).
fn verified_in(models_dir: &Path, entry: &Entry) -> Option<PathBuf> {
    let dir = dir_in(models_dir, entry);
    let expected = installed::expected(entry, &installed::record_path_for_dir(&dir))?;
    expected
        .files
        .iter()
        .all(|pinned| model_integrity::is_marked(pinned, &dir.join(pinned.file)))
        .then_some(dir)
}

/// The installed and verified companion folder of the Whisper model
/// `whisper_model_id`, or `None`. Cheap and offline (see [`verified_in`]), so
/// the engine can ask on every model load.
pub fn installed_companion(whisper_model_id: &str) -> Option<PathBuf> {
    let entry = companion_for(whisper_model_id)?;
    verified_in(&crate::paths::models_dir(), &entry)
}

/// What Settings shows for a companion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub companion_of: Vec<String>,
    /// Installed: its files; otherwise what a download fetches. `None` while
    /// unknown.
    pub size: Option<u64>,
    pub installed: bool,
    /// The percentage of a running download.
    pub downloading: Option<u8>,
}

/// Running downloads by companion id: their cancellation and progress.
static DOWNLOADS: Lazy<Mutex<HashMap<String, (CancellationToken, u8)>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn downloads() -> std::sync::MutexGuard<'static, HashMap<String, (CancellationToken, u8)>> {
    DOWNLOADS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn status_in(models_dir: &Path, entry: &Entry) -> CompanionStatus {
    let dir = dir_in(models_dir, entry);
    let installed = verified_in(models_dir, entry).is_some();
    let size = installed::expected(entry, &installed::record_path_for_dir(&dir))
        .map(|expected| expected.total_size())
        .or_else(|| sizes::download_size(entry));
    CompanionStatus {
        id: entry.id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        companion_of: entry.companion_of.clone(),
        size,
        installed,
        downloading: downloads().get(&entry.id).map(|(_, percent)| *percent),
    }
}

fn emit<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Work that must not lose its engine to an unload: anything but a model
/// download or onboarding (as `service::engines_busy`).
fn engines_busy() -> bool {
    busy::current()
        .into_iter()
        .any(|reason| !matches!(reason, BusyReason::ModelDownload | BusyReason::Onboarding))
}

/// Unloads the speech engines when nothing uses them, so the next load sees
/// a companion that was just installed or deleted. While something runs,
/// the idle unloader (`audio::common`) does it later.
async fn unload_engines_if_idle() {
    if engines_busy() {
        return;
    }
    let _guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
    if !engines_busy() {
        crate::audio::common::unload_both_stt_engines().await;
    }
}

/// The companion of the Whisper model `whisper_model` and its state; `None`
/// when the model has none. An unknown size is read from Hugging Face in the
/// background, and [`CHANGED_EVENT`] follows.
#[tauri::command]
pub async fn openvino_companion_status<R: Runtime>(
    app: AppHandle<R>,
    whisper_model: String,
) -> Result<Option<CompanionStatus>, String> {
    let Some(entry) = companion_for(&whisper_model) else { return Ok(None) };
    let status = status_in(&crate::paths::models_dir(), &entry);
    if status.size.is_none() {
        tauri::async_runtime::spawn(async move {
            if sizes::fill(&huggingface::client(), huggingface::HUB, &[entry]).await {
                emit(&app);
            }
        });
    }
    Ok(Some(status))
}

/// Downloads the companion `id`; resolves when it is installed, fails or is
/// cancelled. Progress follows as [`CHANGED_EVENT`]. Registers with the busy
/// registry for its lifetime, like every model download.
#[tauri::command]
pub async fn openvino_companion_download<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let entry = companion(&id).ok_or_else(|| format!("{id} is not in the model list"))?;
    let cancel = CancellationToken::new();
    {
        let mut downloads = downloads();
        if downloads.contains_key(&id) {
            return Err(format!("{} is already downloading", entry.name));
        }
        downloads.insert(id.clone(), (cancel.clone(), 0));
    }
    emit(&app);
    let _busy = busy::hold(BusyReason::ModelDownload);
    let files = huggingface::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_default();
    let mut last = Instant::now() - PROGRESS_INTERVAL;
    let result = download_into(
        &huggingface::client(),
        &files,
        huggingface::HUB,
        &crate::paths::models_dir(),
        &entry,
        &cancel,
        |done, total| {
            if last.elapsed() < PROGRESS_INTERVAL {
                return;
            }
            last = Instant::now();
            // At most 99 until the record says complete.
            let percent = (done.saturating_mul(100) / total.max(1)).min(99) as u8;
            if let Some(download) = downloads().get_mut(&id) {
                download.1 = percent;
            }
            emit(&app);
        },
    )
    .await;
    downloads().remove(&id);
    match &result {
        Ok(dir) => {
            log::info!("[openvino] {} installed in {}", entry.id, dir.display());
            unload_engines_if_idle().await;
        }
        Err(error) if error.to_string() == CANCELLED => log::info!("[openvino] the download of {} was cancelled", entry.id),
        Err(error) => log::error!("[openvino] the download of {} failed: {error:#}", entry.id),
    }
    emit(&app);
    result.map(drop).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn openvino_companion_cancel(id: String) -> Result<(), String> {
    match downloads().get(&id) {
        Some((cancel, _)) => {
            cancel.cancel();
            Ok(())
        }
        None => Err(format!("{id} is not downloading")),
    }
}

/// Deletes the companion `id`. Refused during a download of it and while the
/// speech engines are at work: the loaded pipeline maps these files, so they
/// are unloaded first, under the engine lifecycle lock.
#[tauri::command]
pub async fn openvino_companion_delete<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
    let entry = companion(&id).ok_or_else(|| format!("{id} is not in the model list"))?;
    if downloads().contains_key(&id) {
        return Err(format!("Cancel the download of {} first", entry.name));
    }
    let busy_message = || "Protocol is transcribing right now. Delete the model when it is done.".to_string();
    if engines_busy() {
        return Err(busy_message());
    }
    {
        let _guard = crate::audio::common::acquire_engine_lifecycle_lock().await;
        if engines_busy() {
            return Err(busy_message());
        }
        crate::audio::common::unload_both_stt_engines().await;
        remove_in(&crate::paths::models_dir(), &entry).map_err(|error| error.to_string())?;
    }
    log::info!("[openvino] {} deleted", entry.id);
    emit(&app);
    Ok(())
}

/// Removes the record first: a deletion stopped halfway then leaves files
/// nothing trusts, never a record that vouches for missing ones.
fn remove_in(models_dir: &Path, entry: &Entry) -> Result<()> {
    let dir = dir_in(models_dir, entry);
    installed::remove_record(&installed::record_path_for_dir(&dir));
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow!("Could not delete {}: {error}", dir.display())),
    }
}

/// Downloads `entry` into its folder under `models_dir` and returns the
/// folder. `api` reads the repository listing, `files` fetches the files;
/// `progress` gets the bytes done and the total.
async fn download_into(
    api: &reqwest::Client,
    files: &reqwest::Client,
    hub: &str,
    models_dir: &Path,
    entry: &Entry,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    let dir = dir_in(models_dir, entry);
    let record_path = installed::record_path_for_dir(&dir);
    let plan = tokio::select! {
        _ = cancel.cancelled() => bail!(CANCELLED),
        plan = installed::plan_download(api, hub, entry, &record_path) => plan?,
    };
    tokio::fs::create_dir_all(&dir).await?;
    if !plan.keep_partial {
        // Partial files of another commit would only fail their final hash.
        for file in &plan.resolved.files {
            let path = dir.join(&file.name);
            if tokio::fs::metadata(&path).await.is_ok_and(|metadata| metadata.len() < file.pinned.size) {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
    }
    installed::write_record(&record_path, &InstallRecord::from_resolved(&entry.id, &plan.resolved, false))
        .map_err(|error| anyhow!("Could not write the install record of {}: {error}", entry.name))?;

    let total = plan.resolved.total_size();
    let mut done = 0u64;
    for file in &plan.resolved.files {
        let pinned = file.pinned;
        let path = dir.join(&file.name);
        let on_disk = tokio::fs::metadata(&path).await.map(|metadata| metadata.len()).unwrap_or(0);
        if on_disk == pinned.size {
            // Left by an interrupted download or a marker lost since: hashed
            // once rather than trusted for its size; a mismatch is deleted.
            let token = cancel.clone();
            match model_integrity::ensure_verified_cancellable(pinned, &path, move || token.is_cancelled()).await {
                Ok(()) => {
                    done += pinned.size;
                    progress(done, total);
                    continue;
                }
                Err(_) if cancel.is_cancelled() => bail!(CANCELLED),
                Err(error) => log::warn!("[openvino] {error}; downloading it again"),
            }
        } else if on_disk > pinned.size {
            tokio::fs::remove_file(&path).await?;
        }
        let resume = tokio::fs::metadata(&path).await.map(|metadata| metadata.len()).unwrap_or(0);
        let before = done;
        fetch(files, &file.url, &path, pinned, resume, cancel, |file_done| progress(before + file_done, total)).await?;
        done += pinned.size;
        progress(done, total);
    }
    if cancel.is_cancelled() {
        bail!(CANCELLED);
    }
    installed::write_record(&record_path, &InstallRecord::from_resolved(&entry.id, &plan.resolved, true))
        .map_err(|error| anyhow!("Could not write the install record of {}: {error}", entry.name))?;
    Ok(dir)
}

/// Fetches one file to `path`, resuming after its first `resume` bytes when
/// the server answers the range, and checks it against `pinned` as it
/// streams in. A file that does not match is deleted (`Check::finish`).
async fn fetch(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    pinned: &'static Pinned,
    resume: u64,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64),
) -> Result<()> {
    let mut request = client.get(url);
    if resume > 0 {
        request = request.header(reqwest::header::RANGE, format!("bytes={resume}-"));
    }
    let response = tokio::select! {
        _ = cancel.cancelled() => bail!(CANCELLED),
        result = tokio::time::timeout(STALL, request.send()) => result
            .map_err(|_| anyhow!("Could not download {}: no answer for 30 seconds", pinned.file))??,
    };
    let status = response.status();
    // A 206 must start where the kept bytes end; anything else starts over.
    let resuming = resume > 0
        && status == reqwest::StatusCode::PARTIAL_CONTENT
        && response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|range| range.starts_with(&format!("bytes {resume}-")));
    if !(status == reqwest::StatusCode::OK || resuming) {
        bail!("Could not download {}: the server answered {status}", pinned.file);
    }
    let mut check = if resuming {
        let token = cancel.clone();
        match model_integrity::Check::resume(pinned, path, move || token.is_cancelled()).await {
            Ok(check) => check,
            Err(_) if cancel.is_cancelled() => bail!(CANCELLED),
            Err(error) => return Err(error),
        }
    } else {
        model_integrity::Check::new(pinned)
    };
    let file = if resuming {
        tokio::fs::OpenOptions::new().append(true).open(path).await?
    } else {
        tokio::fs::File::create(path).await?
    };
    let mut writer = tokio::io::BufWriter::with_capacity(8 << 20, file);
    let mut written = if resuming { resume } else { 0 };
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                // The bytes so far stay for the next attempt to resume.
                writer.flush().await?;
                bail!(CANCELLED);
            }
            next = tokio::time::timeout(STALL, stream.next()) => next,
        };
        let chunk = match next {
            Err(_) => bail!("Could not download {}: no data for 30 seconds", pinned.file),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|error| anyhow!("Could not download {}: {error}", pinned.file))?,
        };
        check.update(&chunk)?;
        writer.write_all(&chunk).await?;
        written += chunk.len() as u64;
        progress(written);
    }
    writer.flush().await?;
    // Closed before its marker records the modification time.
    drop(writer);
    if written != pinned.size {
        bail!("Could not download {}: stopped at {written} of {} bytes", pinned.file, pinned.size);
    }
    check.finish(path)?;
    model_integrity::mark_verified(pinned, path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::schema::{CatalogFile, Engine, OPENVINO_IR, OPENVINO_WHISPER_FILES};
    use crate::model_catalog::testing::{entry_for, Hub};

    const COMMIT: &str = "b568445dd5dc8c695bde596f8acbb4694fd6ba64";

    fn companion_entry() -> Entry {
        let mut entry = entry_for(Engine::Whisper, "turbo-ov", "owner/turbo-ov");
        entry.format = OPENVINO_IR.to_string();
        entry.files = OPENVINO_WHISPER_FILES
            .iter()
            .map(|name| CatalogFile { name: name.to_string(), path: name.to_string() })
            .collect();
        entry.companion_of = vec!["large-v3-turbo".to_string()];
        entry.revision = Some(COMMIT.to_string());
        assert!(entry.problems().is_empty(), "{:?}", entry.problems());
        entry
    }

    /// The repository with a distinct small content per file: weights in LFS,
    /// the XML and JSON files in Git, as on Hugging Face.
    fn hub_with_model() -> (Hub, Vec<Vec<u8>>) {
        let mut hub = Hub::new();
        let contents: Vec<Vec<u8>> =
            (0..OPENVINO_WHISPER_FILES.len()).map(|index| vec![index as u8 + 1; 40 + index * 3]).collect();
        let mut repo = hub.repo("owner/turbo-ov", COMMIT);
        for (name, content) in OPENVINO_WHISPER_FILES.iter().zip(&contents) {
            if name.ends_with(".bin") {
                repo.lfs_file(name, content);
            } else {
                repo.git_file(name, content);
            }
        }
        (hub, contents)
    }

    #[tokio::test]
    async fn a_download_installs_every_file_verified_and_the_companion_counts_as_installed() {
        let (hub, contents) = hub_with_model();
        let hub = hub.serve().await;
        let models = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        assert_eq!(verified_in(models.path(), &entry), None);

        let mut reported = Vec::new();
        let client = huggingface::client();
        let dir = download_into(&client, &client, &hub.url, models.path(), &entry, &CancellationToken::new(), |done, total| {
            reported.push((done, total))
        })
        .await
        .unwrap();

        assert_eq!(dir, models.path().join("openvino").join("turbo-ov"));
        for (name, content) in OPENVINO_WHISPER_FILES.iter().zip(&contents) {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), content);
        }
        let total: u64 = contents.iter().map(|content| content.len() as u64).sum();
        assert_eq!(reported.last(), Some(&(total, total)));
        let record = installed::read_record(&installed::record_path_for_dir(&dir)).unwrap();
        assert!(record.complete);
        assert_eq!(record.commit, COMMIT);
        assert_eq!(verified_in(models.path(), &entry), Some(dir.clone()));

        // A file changed since its check loses its marker: not installed
        // until a download checks the folder again, which fetches only it.
        std::fs::write(dir.join("config.json"), b"changed").unwrap();
        assert_eq!(verified_in(models.path(), &entry), None);
        let before = hub.requests(&format!("/owner/turbo-ov/resolve/{COMMIT}/openvino_encoder_model.bin"));
        download_into(&client, &client, &hub.url, models.path(), &entry, &CancellationToken::new(), |_, _| {})
            .await
            .unwrap();
        assert_eq!(hub.requests(&format!("/owner/turbo-ov/resolve/{COMMIT}/openvino_encoder_model.bin")), before);
        assert_eq!(std::fs::read(dir.join("config.json")).unwrap(), contents[8]);
        assert_eq!(verified_in(models.path(), &entry), Some(dir.clone()));

        remove_in(models.path(), &entry).unwrap();
        assert!(!dir.exists());
        assert_eq!(verified_in(models.path(), &entry), None);
    }

    #[tokio::test]
    async fn bytes_that_do_not_match_their_pin_are_deleted_and_the_record_stays_incomplete() {
        let mut hub = Hub::new();
        let mut repo = hub.repo("owner/turbo-ov", COMMIT);
        for (index, name) in OPENVINO_WHISPER_FILES.iter().enumerate() {
            let content = vec![index as u8 + 1; 50];
            if *name == "openvino_decoder_model.bin" {
                // Listed with one content, served with another.
                repo.lfs_file_serving(name, &content, &[0u8; 50]);
            } else if name.ends_with(".bin") {
                repo.lfs_file(name, &content);
            } else {
                repo.git_file(name, &content);
            }
        }
        let hub = hub.serve().await;
        let models = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        let client = huggingface::client();

        let error = download_into(&client, &client, &hub.url, models.path(), &entry, &CancellationToken::new(), |_, _| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("openvino_decoder_model.bin"), "{error}");
        let dir = dir_in(models.path(), &entry);
        assert!(!dir.join("openvino_decoder_model.bin").exists());
        assert!(!installed::read_record(&installed::record_path_for_dir(&dir)).unwrap().complete);
        assert_eq!(verified_in(models.path(), &entry), None);
    }

    #[tokio::test]
    async fn a_cancelled_download_installs_nothing() {
        let (hub, _) = hub_with_model();
        let hub = hub.serve().await;
        let models = tempfile::tempdir().unwrap();
        let entry = companion_entry();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let client = huggingface::client();
        let error = download_into(&client, &client, &hub.url, models.path(), &entry, &cancel, |_, _| {}).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);
        assert_eq!(verified_in(models.path(), &entry), None);
    }

    #[test]
    fn the_built_in_companion_serves_large_v3_turbo_and_is_found_by_its_models() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        for id in ["large-v3-turbo", "large-v3-turbo-q5_0"] {
            let entry = companion_for(id).unwrap_or_else(|| panic!("{id} has no companion"));
            assert_eq!(entry.repo, "OpenVINO/whisper-large-v3-turbo-int8-ov");
        }
        assert!(companion_for("small").is_none());
    }

    #[test]
    fn the_engine_and_the_catalog_expect_the_same_files() {
        let mut engine: Vec<&str> = crate::whisper_engine::openvino::MODEL_FILES.to_vec();
        let mut catalog: Vec<&str> = OPENVINO_WHISPER_FILES.to_vec();
        engine.sort_unstable();
        catalog.sort_unstable();
        assert_eq!(engine, catalog);
    }
}
