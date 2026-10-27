//! Model updates: whether Hugging Face now has other bytes than an installed
//! model, and replacing the model with them without ever leaving it broken.
//!
//! An update is available when a file's SHA-256 on Hugging Face (its blob id
//! for a file kept in Git) differs from the installed one; a new commit that
//! changes nothing the app downloads is not an update.
//!
//! The update downloads the new version into `<models>/.model-updates/<unit>/`,
//! beside the installed one (unchanged files are copied from it), checks every
//! file, waits for recordings, imports and summaries to finish, and has the
//! engine load it (`Hooks::test_load`). Only then does it swap, under
//! a journal: the installed files move to `previous/`, the new ones take their
//! place, the install record is rewritten, and `previous/` is deleted. A swap
//! that fails is rolled back at once; one cut short by a crash or power loss
//! is rolled back or finished at the next launch ([`recover`]), before any
//! engine lists its models. Until the swap the installed model stays in use,
//! and any failure leaves it as it was.

use super::huggingface::{self, Resolved};
use super::installed::{self, Expected, InstallRecord};
use super::schema::{Engine, Entry};
use crate::model_integrity::{self, Check, Pinned};
use anyhow::{anyhow, Result};
use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const STAGING_DIR: &str = ".model-updates";
const JOURNAL: &str = "swap.json";
const PREVIOUS: &str = "previous";
/// A transfer that sends nothing for this long is treated as failed.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);

pub const CANCELLED: &str = "The model update was cancelled";

/// Where a catalog model is installed under the models folder.
#[derive(Debug, Clone, PartialEq)]
pub struct Unit {
    pub engine: Engine,
    pub id: String,
    /// The folder holding the model's files.
    pub dir: PathBuf,
    /// File names on disk, in catalog order.
    pub files: Vec<String>,
    pub record_path: PathBuf,
    /// `<models>/.model-updates/<engine>-<id>`.
    pub staging: PathBuf,
}

impl Unit {
    /// The layout the engines use: Whisper files in the models folder,
    /// Parakeet folders in `parakeet/`, summary files in `summary/`.
    pub fn of(models_root: &Path, entry: &Entry) -> Self {
        let files: Vec<String> = entry.files.iter().map(|file| file.name.clone()).collect();
        let (dir, record_path) = match entry.engine {
            Engine::Whisper => (models_root.to_path_buf(), installed::record_path_for_file(&models_root.join(&files[0]))),
            Engine::Parakeet => {
                let dir = models_root.join("parakeet").join(&entry.id);
                (dir.clone(), installed::record_path_for_dir(&dir))
            }
            Engine::Llama => {
                let dir = models_root.join("summary");
                (dir.clone(), installed::record_path_for_file(&dir.join(&files[0])))
            }
        };
        // Ids may hold ':' (qwen3.5:2b), which Windows paths cannot.
        let safe_id: String = entry
            .id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
            .collect();
        let staging = models_root.join(STAGING_DIR).join(format!("{}-{safe_id}", entry.engine.as_str()));
        Self { engine: entry.engine, id: entry.id.clone(), dir, files, record_path, staging }
    }

    pub fn path(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// What the installed copy was verified against, when every file is there.
    pub fn installed(&self, entry: &Entry) -> Option<Expected> {
        let expected = installed::expected(entry, &self.record_path)?;
        self.files.iter().all(|name| self.path(name).is_file()).then_some(expected)
    }
}

/// An update Settings offers on a model's card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub engine: Engine,
    pub id: String,
    pub from_commit: String,
    pub to_commit: String,
    /// Bytes to download: the files that changed.
    pub download_bytes: u64,
}

/// Compares the installed copy of `entry` with its files on Hugging Face now.
/// Nothing is downloaded: LFS files compare SHA-256, Git files their blob id
/// (computed from the installed file when its record has none).
pub async fn check(client: &reqwest::Client, hub: &str, entry: &Entry, unit: &Unit) -> Result<Option<Available>> {
    let Some(expected) = unit.installed(entry) else { return Ok(None) };
    let commit = huggingface::current_commit(client, hub, entry).await?;
    let listed = huggingface::listing(client, hub, entry, &commit).await?;
    let mut download_bytes = 0;
    let mut changed = false;
    for (index, file) in listed.iter().enumerate() {
        let pinned = expected.pin(&file.name).ok_or_else(|| anyhow!("{} has no installed {}", entry.id, file.name))?;
        let differs = match &file.sha256 {
            Some(sha256) => *sha256 != pinned.sha256 || file.size != pinned.size,
            None => match expected.git_oids.get(index).cloned().flatten() {
                Some(git_oid) => git_oid != file.git_oid,
                None => {
                    let content = tokio::fs::read(unit.path(&file.name)).await?;
                    huggingface::git_blob_id(&content) != file.git_oid
                }
            },
        };
        if differs {
            changed = true;
            download_bytes += file.size;
        }
    }
    Ok(changed.then(|| Available {
        engine: entry.engine,
        id: entry.id.clone(),
        from_commit: expected.commit.clone(),
        to_commit: commit,
        download_bytes,
    }))
}

/// Where an update stands, for the model's card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Downloading,
    /// Downloaded; waiting for recordings, imports and summaries to finish.
    Waiting,
    Testing,
    Installing,
}

/// What the app supplies around the files: when heavy work may run, the
/// engine's test load, and the moment of the swap.
pub struct Hooks {
    /// Waits until recordings, imports and summaries are done.
    pub wait_idle: Box<dyn FnOnce() -> BoxFuture<'static, Result<()>> + Send>,
    /// Loads the staged model from its folder with the engine. A load that
    /// can take long (a summary model's probe) stops when the token is
    /// cancelled; a short one may finish first.
    pub test_load: Box<dyn FnOnce(PathBuf, CancellationToken) -> BoxFuture<'static, Result<()>> + Send>,
    /// Waits until the model may be replaced, unloads it, and returns a guard
    /// held for the swap (the engine lifecycle lock).
    pub lock_for_swap: Box<dyn FnOnce() -> BoxFuture<'static, Result<Box<dyn Send>>> + Send>,
    pub phase: Box<dyn Fn(Phase, u64, u64) + Send + Sync>,
}

/// Updates the installed copy of `entry` to its current version on `hub`.
/// On any failure or cancellation the installed model is left as it was and
/// the staging folder removed.
pub async fn run(
    api: &reqwest::Client,
    files_client: &reqwest::Client,
    hub: &str,
    entry: &Entry,
    unit: &Unit,
    cancel: &CancellationToken,
    hooks: Hooks,
) -> Result<Resolved> {
    let result = stage_and_swap(api, files_client, hub, entry, unit, cancel, hooks).await;
    if unit.staging.exists() && !unit.staging.join(JOURNAL).exists() {
        let _ = tokio::fs::remove_dir_all(&unit.staging).await;
    }
    result
}

async fn stage_and_swap(
    api: &reqwest::Client,
    files_client: &reqwest::Client,
    hub: &str,
    entry: &Entry,
    unit: &Unit,
    cancel: &CancellationToken,
    hooks: Hooks,
) -> Result<Resolved> {
    let expected = unit.installed(entry).ok_or_else(|| anyhow!("{} is not installed", entry.name))?;
    // Every race with Cancel is `biased`, Cancel first: an unbiased select
    // picks a ready branch at random, and a Cancel pressed before the swap
    // must always keep the installed model.
    let resolved = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(anyhow!(CANCELLED)),
        resolved = huggingface::resolve(api, hub, entry) => resolved?,
    };
    let _ = tokio::fs::remove_dir_all(&unit.staging).await;
    tokio::fs::create_dir_all(&unit.staging).await?;

    let total = resolved.total_size();
    let mut done = 0u64;
    (hooks.phase)(Phase::Downloading, 0, total);
    for file in &resolved.files {
        let target = unit.staging.join(&file.name);
        let unchanged = expected.pin(&file.name).is_some_and(|pinned| pinned == file.pinned);
        if unchanged {
            // The same bytes: copied from the installed file and hashed again.
            tokio::fs::copy(unit.path(&file.name), &target).await?;
            let flag = cancel.clone();
            model_integrity::ensure_verified_cancellable(file.pinned, &target, move || flag.is_cancelled())
                .await
                .map_err(|error| if cancel.is_cancelled() { anyhow!(CANCELLED) } else { error })?;
            done += file.pinned.size;
        } else {
            download(files_client, &file.url, file.pinned, &target, cancel, |bytes| (hooks.phase)(Phase::Downloading, done + bytes, total))
                .await?;
            done += file.pinned.size;
            model_integrity::mark_verified(file.pinned, &target);
        }
        (hooks.phase)(Phase::Downloading, done, total);
    }

    (hooks.phase)(Phase::Waiting, total, total);
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(anyhow!(CANCELLED)),
        idle = (hooks.wait_idle)() => idle?,
    };
    (hooks.phase)(Phase::Testing, total, total);
    let loaded = (hooks.test_load)(unit.staging.clone(), cancel.clone()).await;
    if cancel.is_cancelled() {
        return Err(anyhow!(CANCELLED));
    }
    loaded.map_err(|error| anyhow!("The new version did not load, so the installed one was kept: {error}"))?;
    let guard = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(anyhow!(CANCELLED)),
        guard = (hooks.lock_for_swap)() => guard?,
    };
    // The app refuses Cancel once the phase is Installing, and moves to it
    // under the same lock as it takes a Cancel, so a Cancel taken before
    // this point is seen here.
    (hooks.phase)(Phase::Installing, total, total);
    if cancel.is_cancelled() {
        return Err(anyhow!(CANCELLED));
    }
    swap(unit, &resolved)?;
    drop(guard);
    Ok(resolved)
}

/// Streams `url` into `target`, checking it against `pinned` as it arrives.
async fn download(
    client: &reqwest::Client,
    url: &str,
    pinned: &'static Pinned,
    target: &Path,
    cancel: &CancellationToken,
    progress: impl Fn(u64),
) -> Result<()> {
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(anyhow!(CANCELLED)),
        response = client.get(url).send() => response.map_err(|error| anyhow!("Couldn't download {}: {error}", pinned.file))?,
    };
    if !response.status().is_success() {
        return Err(anyhow!("Hugging Face answered {} for {}", response.status(), pinned.file));
    }
    if let Some(length) = response.content_length().filter(|length| *length != pinned.size) {
        return Err(model_integrity::IntegrityError::ServerSize { file: pinned.file, size: length, expected: pinned.size }.into());
    }
    let mut check = Check::new(pinned);
    let mut file = tokio::fs::File::create(target).await?;
    let mut stream = response.bytes_stream();
    let mut received = 0u64;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(anyhow!(CANCELLED)),
            next = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => next,
        };
        let chunk = match next {
            Err(_) => return Err(anyhow!("The download of {} stalled; check your connection and retry", pinned.file)),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|error| anyhow!("Couldn't download {}: {error}", pinned.file))?,
        };
        check.update(&chunk)?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        progress(received);
    }
    file.flush().await?;
    drop(file);
    check.finish(target)?;
    Ok(())
}

/// The swap in progress, so a launch after a crash can finish or undo it.
#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    dir: PathBuf,
    files: Vec<String>,
    record_path: PathBuf,
    /// The record to put back on a rollback; `None` for a 0.3.x install.
    old_record: Option<InstallRecord>,
    new_record: InstallRecord,
}

fn write_journal(staging: &Path, journal: &Journal) -> std::io::Result<()> {
    super::write_atomically(&staging.join(JOURNAL), &serde_json::to_vec_pretty(journal)?)
}

/// Moves the staged files into place. On failure everything is put back.
fn swap(unit: &Unit, resolved: &Resolved) -> Result<()> {
    let journal = Journal {
        dir: unit.dir.clone(),
        files: unit.files.clone(),
        record_path: unit.record_path.clone(),
        old_record: installed::read_record(&unit.record_path),
        new_record: InstallRecord::from_resolved(&unit.id, resolved, true),
    };
    write_journal(&unit.staging, &journal)?;
    let result = move_into_place(&journal, &unit.staging);
    match &result {
        Ok(()) => {
            for file in &resolved.files {
                model_integrity::mark_verified(file.pinned, &unit.path(&file.name));
            }
            finish(&unit.staging);
        }
        Err(error) => {
            log::error!("[model update] swap of {} failed, rolling back: {error}", unit.id);
            roll_back(&journal, &unit.staging);
        }
    }
    result
}

fn move_into_place(journal: &Journal, staging: &Path) -> Result<()> {
    let previous = staging.join(PREVIOUS);
    std::fs::create_dir_all(&previous)?;
    for name in &journal.files {
        let installed = journal.dir.join(name);
        model_integrity::clear_mark(&installed);
        if installed.exists() {
            std::fs::rename(&installed, previous.join(name))
                .map_err(|error| anyhow!("{name} is in use and could not be replaced ({error}); retry when the model is not in use"))?;
        }
    }
    for name in &journal.files {
        std::fs::rename(staging.join(name), journal.dir.join(name))?;
    }
    installed::write_record(&journal.record_path, &journal.new_record)?;
    Ok(())
}

/// Puts the previous files and record back.
fn roll_back(journal: &Journal, staging: &Path) {
    let previous = staging.join(PREVIOUS);
    for name in &journal.files {
        let kept = previous.join(name);
        if kept.exists() {
            let installed = journal.dir.join(name);
            model_integrity::clear_mark(&installed);
            let _ = std::fs::remove_file(&installed);
            if let Err(error) = std::fs::rename(&kept, &installed) {
                log::error!("[model update] could not restore {}: {error}", installed.display());
            }
        }
    }
    match &journal.old_record {
        Some(record) => {
            let _ = installed::write_record(&journal.record_path, record);
        }
        None => installed::remove_record(&journal.record_path),
    }
    finish(staging);
}

fn finish(staging: &Path) {
    if let Err(error) = std::fs::remove_file(staging.join(JOURNAL)) {
        log::warn!("[model update] could not remove the journal in {}: {error}", staging.display());
    }
    if let Err(error) = std::fs::remove_dir_all(staging) {
        log::warn!("[model update] could not remove {}: {error}", staging.display());
    }
}

/// At launch, before the engines list their models: finishes a swap whose
/// record was already written, rolls back any other, and removes unfinished
/// downloads (an update starts over).
pub fn recover(models_root: &Path) {
    let Ok(dirs) = std::fs::read_dir(models_root.join(STAGING_DIR)) else { return };
    for staging in dirs.flatten().map(|dir| dir.path()).filter(|path| path.is_dir()) {
        let journal = std::fs::read(staging.join(JOURNAL))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).ok());
        match journal {
            Some(journal) => {
                let done = installed::read_record(&journal.record_path).is_some_and(|record| record == journal.new_record)
                    && journal.files.iter().all(|name| journal.dir.join(name).is_file());
                if done {
                    log::info!("[model update] finishing the update in {}", staging.display());
                    finish(&staging);
                } else {
                    log::warn!("[model update] rolling back the interrupted update in {}", staging.display());
                    roll_back(&journal, &staging);
                }
            }
            None => {
                let _ = std::fs::remove_dir_all(&staging);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::testing::{entry_for, Hub};
    use sha2::{Digest, Sha256};
    use std::sync::{Arc, Mutex};

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";
    const REPO: &str = "owner/parakeet";

    fn parakeet_files(encoder: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("encoder-model.int8.onnx", encoder.to_vec()),
            ("decoder_joint-model.int8.onnx", vec![2u8; 300]),
            ("nemo128.onnx", vec![3u8; 100]),
            ("vocab.txt", b"<unk>\n".to_vec()),
        ]
    }

    /// Installs `files` as `entry` at `commit`, as a finished download would.
    fn install(unit: &Unit, files: &[(&str, Vec<u8>)], commit: &str) {
        std::fs::create_dir_all(&unit.dir).unwrap();
        for (name, content) in files {
            std::fs::write(unit.path(name), content).unwrap();
        }
        let record = InstallRecord {
            id: unit.id.clone(),
            repo: REPO.to_string(),
            commit: commit.to_string(),
            complete: true,
            files: files
                .iter()
                .map(|(name, content)| installed::RecordFile {
                    name: name.to_string(),
                    size: content.len() as u64,
                    sha256: format!("{:x}", Sha256::digest(content)),
                    git_oid: Some(huggingface::git_blob_id(content)),
                })
                .collect(),
        };
        installed::write_record(&unit.record_path, &record).unwrap();
    }

    async fn serve(files: &[(&str, Vec<u8>)], commit: &str) -> crate::model_catalog::testing::ServedHub {
        let mut hub = Hub::new();
        let mut repo = hub.repo(REPO, commit);
        for (name, content) in files {
            if *name == "vocab.txt" {
                repo.git_file(name, content);
            } else {
                repo.lfs_file(name, content);
            }
        }
        hub.serve().await
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        entry: Entry,
        unit: Unit,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let entry = entry_for(Engine::Parakeet, "parakeet-tdt-0.6b-v3-int8", REPO);
        let unit = Unit::of(dir.path(), &entry);
        Fixture { _dir: dir, entry, unit }
    }

    fn hooks(test_load: Result<(), &'static str>, phases: Arc<Mutex<Vec<Phase>>>) -> Hooks {
        Hooks {
            test_load: Box::new(move |dir, _| {
                Box::pin(async move {
                    assert!(dir.join("encoder-model.int8.onnx").is_file());
                    test_load.map_err(|message| anyhow!(message))
                })
            }),
            wait_idle: Box::new(|| Box::pin(async { Ok(()) })),
            lock_for_swap: Box::new(|| Box::pin(async { Ok(Box::new(()) as Box<dyn Send>) })),
            phase: Box::new(move |phase, _, _| {
                let mut phases = phases.lock().unwrap();
                if phases.last() != Some(&phase) {
                    phases.push(phase);
                }
            }),
        }
    }

    fn content(unit: &Unit, name: &str) -> Vec<u8> {
        std::fs::read(unit.path(name)).unwrap()
    }

    #[tokio::test]
    async fn an_update_is_offered_only_when_a_file_changed() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let client = huggingface::client();

        // A new commit with the same bytes is not an update.
        let hub = serve(&parakeet_files(&[1u8; 500]), NEW).await;
        assert_eq!(check(&client, &hub.url, &f.entry, &f.unit).await.unwrap(), None);

        let hub = serve(&parakeet_files(&[9u8; 700]), NEW).await;
        let available = check(&client, &hub.url, &f.entry, &f.unit).await.unwrap().unwrap();
        assert_eq!((available.from_commit.as_str(), available.to_commit.as_str()), (OLD, NEW));
        assert_eq!(available.download_bytes, 700);
        // The check downloads nothing.
        assert_eq!(hub.requests(&format!("/{REPO}/resolve/{NEW}/vocab.txt")), 0);
    }

    #[tokio::test]
    async fn a_changed_git_file_of_a_0_3_x_install_is_found_from_its_bytes() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        // 0.3.x wrote no blob ids.
        let mut record = installed::read_record(&f.unit.record_path).unwrap();
        record.files.iter_mut().for_each(|file| file.git_oid = None);
        installed::write_record(&f.unit.record_path, &record).unwrap();
        let mut files = parakeet_files(&[1u8; 500]);
        files[3].1 = b"<unk>\n<s>\n".to_vec();
        let hub = serve(&files, NEW).await;
        let available = check(&huggingface::client(), &hub.url, &f.entry, &f.unit).await.unwrap().unwrap();
        assert_eq!(available.download_bytes, files[3].1.len() as u64);
    }

    #[tokio::test]
    async fn an_update_swaps_in_the_new_version_and_deletes_the_old_one() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let hub = serve(&parakeet_files(&[9u8; 700]), NEW).await;
        let phases = Arc::new(Mutex::new(Vec::new()));
        let client = huggingface::client();

        let resolved = run(&client, &client, &hub.url, &f.entry, &f.unit, &CancellationToken::new(), hooks(Ok(()), phases.clone()))
            .await
            .unwrap();
        assert_eq!(resolved.commit, NEW);
        assert_eq!(content(&f.unit, "encoder-model.int8.onnx"), [9u8; 700]);
        let record = installed::read_record(&f.unit.record_path).unwrap();
        assert_eq!((record.commit.as_str(), record.complete), (NEW, true));
        assert!(!f.unit.staging.exists());
        assert_eq!(*phases.lock().unwrap(), [Phase::Downloading, Phase::Waiting, Phase::Testing, Phase::Installing]);
        // Unchanged files were copied, not downloaded.
        assert_eq!(hub.requests(&format!("/{REPO}/resolve/{NEW}/nemo128.onnx")), 0);
        assert_eq!(hub.requests(&format!("/{REPO}/resolve/{NEW}/encoder-model.int8.onnx")), 1);
        // The swapped files are trusted without hashing them again.
        let expected = f.unit.installed(&f.entry).unwrap();
        model_integrity::ensure_verified(expected.pin("encoder-model.int8.onnx").unwrap(), &f.unit.path("encoder-model.int8.onnx"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_failed_test_load_keeps_the_installed_version() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let hub = serve(&parakeet_files(&[9u8; 700]), NEW).await;
        let client = huggingface::client();
        let error = run(&client, &client, &hub.url, &f.entry, &f.unit, &CancellationToken::new(), hooks(Err("bad graph"), Arc::default()))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("did not load, so the installed one was kept: bad graph"), "{error}");
        assert_eq!(content(&f.unit, "encoder-model.int8.onnx"), [1u8; 500]);
        assert_eq!(installed::read_record(&f.unit.record_path).unwrap().commit, OLD);
        assert!(!f.unit.staging.exists());
    }

    #[tokio::test]
    async fn a_hash_mismatch_keeps_the_installed_version() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let mut hub = Hub::new();
        // Listed as one file, served as another of the same size.
        hub.repo(REPO, NEW)
            .lfs_file_serving("encoder-model.int8.onnx", &[9u8; 700], &[8u8; 700])
            .lfs_file("decoder_joint-model.int8.onnx", &[2u8; 300])
            .lfs_file("nemo128.onnx", &[3u8; 100])
            .git_file("vocab.txt", b"<unk>\n");
        let hub = hub.serve().await;
        let client = huggingface::client();
        let error = run(&client, &client, &hub.url, &f.entry, &f.unit, &CancellationToken::new(), hooks(Ok(()), Arc::default()))
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("failed its integrity check"), "{error}");
        assert_eq!(content(&f.unit, "encoder-model.int8.onnx"), [1u8; 500]);
        assert!(!f.unit.staging.exists());
    }

    #[tokio::test]
    async fn a_cancelled_update_keeps_the_installed_version() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let hub = serve(&parakeet_files(&[9u8; 700]), NEW).await;
        let cancel = CancellationToken::new();
        let mut hooks = hooks(Ok(()), Arc::default());
        // Cancelled while waiting for a recording to end.
        let waiting = cancel.clone();
        hooks.wait_idle = Box::new(move || {
            Box::pin(async move {
                waiting.cancel();
                std::future::pending::<Result<()>>().await
            })
        });
        let client = huggingface::client();
        let error = run(&client, &client, &hub.url, &f.entry, &f.unit, &cancel, hooks).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);
        assert_eq!(content(&f.unit, "encoder-model.int8.onnx"), [1u8; 500]);
        assert!(!f.unit.staging.exists());
    }

    /// Runs an update whose `hooks` press Cancel at some point, and checks
    /// that the installed model was kept.
    async fn cancelled_at(cancel: CancellationToken, hooks: Hooks) {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let hub = serve(&parakeet_files(&[9u8; 700]), NEW).await;
        let client = huggingface::client();
        let error = run(&client, &client, &hub.url, &f.entry, &f.unit, &cancel, hooks).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);
        assert_eq!(content(&f.unit, "encoder-model.int8.onnx"), [1u8; 500]);
        assert_eq!(installed::read_record(&f.unit.record_path).unwrap().commit, OLD);
        assert!(!f.unit.staging.exists());
    }

    #[tokio::test]
    async fn a_cancel_before_the_swap_always_keeps_the_installed_version() {
        // During a test load that cannot stop and succeeds, with the swap
        // lock free at once: each time, not about half the time.
        for _ in 0..20 {
            let cancel = CancellationToken::new();
            let mut pressing = hooks(Ok(()), Arc::default());
            let pressed = cancel.clone();
            pressing.test_load = Box::new(move |_, _| Box::pin(async move { pressed.cancel(); Ok(()) }));
            cancelled_at(cancel, pressing).await;
        }

        // A probe that stops on Cancel: reported as the cancel, not as a model
        // that did not load.
        let cancel = CancellationToken::new();
        let mut pressing = hooks(Ok(()), Arc::default());
        let pressed = cancel.clone();
        pressing.test_load = Box::new(move |_, token| {
            Box::pin(async move {
                pressed.cancel();
                token.cancelled().await;
                Err(anyhow!("The test load was cancelled"))
            })
        });
        cancelled_at(cancel, pressing).await;

        // Taken just before the phase became Installing.
        let cancel = CancellationToken::new();
        let mut pressing = hooks(Ok(()), Arc::default());
        let pressed = cancel.clone();
        pressing.phase = Box::new(move |phase, _, _| if phase == Phase::Installing { pressed.cancel() });
        cancelled_at(cancel, pressing).await;
    }

    #[test]
    fn a_failed_swap_rolls_back_and_recovery_handles_an_interrupted_one() {
        let f = fixture();
        install(&f.unit, &parakeet_files(&[1u8; 500]), OLD);
        let old_record = installed::read_record(&f.unit.record_path).unwrap();
        let mut new_record = old_record.clone();
        new_record.commit = NEW.to_string();

        // Interrupted after two files moved out and one moved in.
        std::fs::create_dir_all(f.unit.staging.join(PREVIOUS)).unwrap();
        for name in &f.unit.files {
            std::fs::write(f.unit.staging.join(name), b"new").unwrap();
        }
        let journal = Journal {
            dir: f.unit.dir.clone(),
            files: f.unit.files.clone(),
            record_path: f.unit.record_path.clone(),
            old_record: Some(old_record.clone()),
            new_record: new_record.clone(),
        };
        write_journal(&f.unit.staging, &journal).unwrap();
        for name in &f.unit.files[..2] {
            std::fs::rename(f.unit.path(name), f.unit.staging.join(PREVIOUS).join(name)).unwrap();
        }
        std::fs::rename(f.unit.staging.join(&f.unit.files[0]), f.unit.path(&f.unit.files[0])).unwrap();

        recover(f.unit.dir.parent().unwrap().parent().unwrap());
        assert_eq!(content(&f.unit, "encoder-model.int8.onnx"), [1u8; 500]);
        assert_eq!(content(&f.unit, "decoder_joint-model.int8.onnx"), [2u8; 300]);
        assert_eq!(installed::read_record(&f.unit.record_path).unwrap(), old_record);
        assert!(!f.unit.staging.exists());

        // Interrupted after the record was written: the update is kept.
        std::fs::create_dir_all(f.unit.staging.join(PREVIOUS)).unwrap();
        write_journal(&f.unit.staging, &journal).unwrap();
        installed::write_record(&f.unit.record_path, &new_record).unwrap();
        recover(f.unit.dir.parent().unwrap().parent().unwrap());
        assert_eq!(installed::read_record(&f.unit.record_path).unwrap(), new_record);
        assert!(!f.unit.staging.exists());

        // A download cut short is removed.
        std::fs::create_dir_all(&f.unit.staging).unwrap();
        std::fs::write(f.unit.staging.join("encoder-model.int8.onnx"), b"part").unwrap();
        recover(f.unit.dir.parent().unwrap().parent().unwrap());
        assert!(!f.unit.staging.exists());
    }

    #[test]
    fn units_follow_the_engines_layout() {
        let root = Path::new("models");
        let whisper = Unit::of(root, &entry_for(Engine::Whisper, "tiny", "o/w"));
        assert_eq!(whisper.path("ggml-tiny.bin"), root.join("ggml-tiny.bin"));
        assert_eq!(whisper.record_path, root.join("ggml-tiny.bin.install.json"));
        let llama = Unit::of(root, &entry_for(Engine::Llama, "qwen3.5:2b", "o/q"));
        assert_eq!(llama.dir, root.join("summary"));
        assert_eq!(llama.staging, root.join(STAGING_DIR).join("llama-qwen3.5_2b"));
    }
}
