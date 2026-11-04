//! Inference runtimes downloaded on each PC (#79): the libraries of a
//! `runtimes` entry of the catalog, taken from their vendor's own archive.
//! Protocol ships none of them; the catalog pins the archive and every file
//! by size and SHA-256, so a new version reaches installs without a release.
//!
//! On disk a runtime is `<data>/runtimes/<id>/<version>/`: the pinned files,
//! a `.verified` marker beside each and `runtime.json`, the record of what
//! was installed (written last). An install is atomic: the archive is
//! downloaded into `.staging-<version>/` beside the versions, checked
//! against its pin, only the pinned files are extracted, each checked
//! against its own pin (and each library against its publisher's
//! signature), the archive is deleted, and the folder is renamed to
//! `<version>`. A failure or a cancel removes the staging folder, so a
//! version folder is always complete; a staging folder left by a crash is
//! removed by the next install or [`prune_in`].
//!
//! The catalog is not signed, so it does not choose where the code comes
//! from: the archive's host and the libraries' signer are this build's, per
//! runtime id (`schema::runtime_host`, `schema::runtime_signer`), and a
//! redirect off that host fails the download ([`Fetch::Vendor`]).
//!
//! Which installed version is loaded, and when old ones are removed, is the
//! caller's (`super::openvino`): a loaded library cannot be deleted on
//! Windows, so a version is pruned only when this process has not loaded it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use super::schema::{self, RuntimeEntry};
use crate::model_integrity::{self, Pinned};

/// The message of a cancelled install; Settings does not show it as an error.
pub const CANCELLED: &str = "The download was cancelled";

/// The record of an installed version.
const RECORD: &str = "runtime.json";

/// The prefix of an install in progress.
const STAGING: &str = ".staging-";

/// A stalled transfer fails after this long without a byte, like the model
/// downloads.
const STALL: Duration = Duration::from_secs(30);

/// The file names inside a runtime folder that are not runtime files.
const ARCHIVE: &str = "archive.zip";

/// How long a rename or deletion waits out a lock on a freshly written file
/// (an antivirus scan of the new libraries, the search indexer) before it
/// fails: Windows refuses to rename a folder while a file in it is open, and
/// a failure there would throw away a checked download.
const LOCK_PATIENCE: Duration = Duration::from_secs(20);

/// Where an install fetches from and what it checks beyond the pins.
pub enum Fetch {
    /// The runtime's vendor: the archive URL must be on the host this build
    /// pins for the runtime, redirects go only to https on that host, and
    /// every `.dll` must carry the Authenticode signature of its publisher.
    Vendor,
    /// A test's server and unsigned files: the pins only.
    #[cfg(test)]
    Local(reqwest::Client),
    /// A test's server, and libraries signed by this publisher.
    #[cfg(test)]
    LocalSigned(reqwest::Client, &'static str),
}

/// Whether a redirect may go to `url`: https on the pinned `host`, without
/// a port or a user.
fn redirect_allowed(url: &reqwest::Url, host: &str) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.host_str().is_some_and(|found| found.eq_ignore_ascii_case(host))
}

/// The client that downloads `entry` from its vendor, and the publisher
/// whose signature its libraries need.
fn vendor_client(entry: &RuntimeEntry) -> Result<(reqwest::Client, &'static str)> {
    let (Some(host), Some(signer)) = (schema::runtime_host(&entry.id), schema::runtime_signer(&entry.id)) else {
        bail!("{} is not a runtime this version of Protocol installs", entry.id);
    };
    if !schema::is_archive_url(&entry.archive.url, host) {
        bail!("The model list names an archive of {} that is not on https://{host}/", entry.name);
    }
    let client = super::huggingface::builder()
        .connect_timeout(STALL)
        .redirect(redirect_policy(host))
        .build()
        .map_err(|error| anyhow!("Could not prepare the download of {}: {error}", entry.name))?;
    Ok((client, signer))
}

fn redirect_policy(host: &'static str) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else if redirect_allowed(attempt.url(), host) {
            attempt.follow()
        } else {
            attempt.error(format!("a redirect left https://{host}/"))
        }
    })
}

/// Runs `operation` until it does not fail on a lock, for up to
/// [`LOCK_PATIENCE`].
async fn patiently<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    // ERROR_ACCESS_DENIED, ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION.
    let locked = |error: &std::io::Error| {
        error.kind() == std::io::ErrorKind::PermissionDenied || matches!(error.raw_os_error(), Some(5 | 32 | 33))
    };
    let started = std::time::Instant::now();
    let mut pause = Duration::from_millis(100);
    loop {
        match operation() {
            Err(error) if locked(&error) && started.elapsed() + pause <= LOCK_PATIENCE => {
                log::info!("[runtime] {error}; trying again in {} ms", pause.as_millis());
                tokio::time::sleep(pause).await;
                pause = (pause * 2).min(Duration::from_secs(2));
            }
            result => return result,
        }
    }
}

/// Where the versions of runtime `id` are kept under `data_dir`.
pub fn root_in(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("runtimes").join(id)
}

/// What an installed version is: written from its catalog entry when the
/// install completes, read without the catalog afterwards, so a runtime the
/// catalog no longer lists keeps loading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeRecord {
    pub id: String,
    pub version: String,
    /// The API level of the catalog entry it was installed from.
    pub api: u32,
    pub files: Vec<RecordFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
}

impl RuntimeRecord {
    fn from_entry(entry: &RuntimeEntry) -> Self {
        Self {
            id: entry.id.clone(),
            version: entry.version.clone(),
            api: entry.api,
            files: entry
                .files
                .iter()
                .map(|file| RecordFile { name: file.name.clone(), size: file.size, sha256: file.sha256.clone() })
                .collect(),
        }
    }

    fn pins(&self) -> impl Iterator<Item = &'static Pinned> + '_ {
        self.files.iter().map(|file| model_integrity::intern(&file.name, file.size, &file.sha256))
    }

    /// The bytes the files take.
    pub fn size(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

/// An installed version of a runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    pub dir: PathBuf,
    pub record: RuntimeRecord,
}

/// The record of the version in `dir` when every file it lists still has a
/// valid verification marker: metadata reads and small file reads, no
/// hashing. A file changed since its check loses its marker, and the version
/// then counts as not installed.
pub fn verified(dir: &Path) -> Option<RuntimeRecord> {
    let record: RuntimeRecord = serde_json::from_slice(&std::fs::read(dir.join(RECORD)).ok()?).ok()?;
    let safe = record.files.iter().all(|file| !file.name.contains(['/', '\\']) && file.name != RECORD);
    (safe && record.pins().zip(&record.files).all(|(pinned, file)| model_integrity::is_marked(pinned, &dir.join(&file.name))))
        .then_some(record)
}

/// The verified versions under `root` (one runtime's folder), newest first.
pub fn installed_in(root: &Path) -> Vec<Installed> {
    let Ok(read) = std::fs::read_dir(root) else { return Vec::new() };
    let mut installed: Vec<Installed> = read
        .flatten()
        .filter(|item| !item.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|item| {
            let dir = item.path();
            let record = verified(&dir)?;
            // A folder named for another version is not what its record says.
            (item.file_name().to_string_lossy() == record.version).then_some(Installed { dir, record })
        })
        .collect();
    installed.sort_by(|a, b| schema::runtime_version_key(&b.record.version).cmp(&schema::runtime_version_key(&a.record.version)));
    installed
}

/// Installs `entry` under `root` (its runtime's folder) and returns the
/// version's folder; a version already installed and verified is kept as it
/// is. `fetch` says where from; `progress` gets the archive bytes done and
/// its size.
pub async fn install_into(
    fetch: &Fetch,
    root: &Path,
    entry: &RuntimeEntry,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    let target = root.join(&entry.version);
    if verified(&target).is_some_and(|record| record == RuntimeRecord::from_entry(entry)) {
        return Ok(target);
    }
    let (client, signer) = match fetch {
        Fetch::Vendor => vendor_client(entry).map(|(client, signer)| (client, Some(signer)))?,
        #[cfg(test)]
        Fetch::Local(client) => (client.clone(), None),
        #[cfg(test)]
        Fetch::LocalSigned(client, signer) => (client.clone(), Some(*signer)),
    };
    let staging = root.join(format!("{STAGING}{}", entry.version));
    remove_dir(&staging)?;
    tokio::fs::create_dir_all(&staging).await?;
    let mut installed = stage(&client, &staging, entry, signer, cancel, &mut progress).await;
    if installed.is_ok() {
        // Only now can a version folder of this name go: one left unverified,
        // or one this record replaces.
        installed = match remove_dir(&target) {
            Ok(()) => patiently(|| std::fs::rename(&staging, &target))
                .await
                .map_err(|error| anyhow!("Could not finish installing {} {}: {error}", entry.name, entry.version)),
            Err(error) => Err(error),
        };
    }
    match installed {
        Ok(()) => Ok(target),
        Err(error) => {
            if let Err(cleanup) = remove_dir(&staging) {
                log::warn!("[runtime] could not remove {}: {cleanup:#}", staging.display());
            }
            Err(error)
        }
    }
}

/// The files of `entry` that the installed version in `dir` lacks, when that
/// version is `entry` with fewer files: a catalog that pinned more files of
/// the same version later (the NPU plugin and the ONNX frontend, #66).
/// `None` when the version is not installed, or its record pins a file
/// otherwise than `entry` does (another build: only a new install replaces it).
pub fn missing_files(dir: &Path, entry: &RuntimeEntry) -> Option<Vec<schema::RuntimeFile>> {
    let record = verified(dir)?;
    let wanted = RuntimeRecord::from_entry(entry);
    let part_of = record.id == wanted.id
        && record.version == wanted.version
        && record.api == wanted.api
        && record.files.iter().all(|file| wanted.files.contains(file));
    part_of.then(|| entry.files.iter().filter(|file| !record.files.iter().any(|kept| kept.name == file.name)).cloned().collect())
}

/// Adds to the installed version of `entry` under `root` the files its record
/// lacks ([`missing_files`]) and returns the version's folder. The files it
/// has are left alone, so this works while this process has the version
/// loaded (Whisper on the GPU): Windows lets a folder whose libraries are in
/// use gain files. The archive is downloaded and checked as an install does,
/// only the missing files are extracted (checked against their pins and
/// signer) into a staging folder and moved in, and the record is rewritten
/// last: a completion cut short leaves files the record does not vouch for,
/// which the next one replaces.
pub async fn complete_into(
    fetch: &Fetch,
    root: &Path,
    entry: &RuntimeEntry,
    cancel: &CancellationToken,
    mut progress: impl FnMut(u64, u64),
) -> Result<PathBuf> {
    let target = root.join(&entry.version);
    let Some(missing) = missing_files(&target, entry) else {
        bail!("{} {} is not installed as the model list pins it", entry.name, entry.version);
    };
    if missing.is_empty() {
        return Ok(target);
    }
    let (client, signer) = match fetch {
        Fetch::Vendor => vendor_client(entry).map(|(client, signer)| (client, Some(signer)))?,
        #[cfg(test)]
        Fetch::Local(client) => (client.clone(), None),
        #[cfg(test)]
        Fetch::LocalSigned(client, signer) => (client.clone(), Some(*signer)),
    };
    let staging = root.join(format!("{STAGING}{}", entry.version));
    remove_dir(&staging)?;
    tokio::fs::create_dir_all(&staging).await?;
    let completed = async {
        let archive = staging.join(ARCHIVE);
        download(&client, &archive, entry, cancel, &mut progress).await?;
        let (from, into, files, token) = (archive.clone(), staging.clone(), missing.clone(), cancel.clone());
        let name = entry.name.clone();
        tokio::task::spawn_blocking(move || extract(&from, &into, &files, &name, signer, &|| token.is_cancelled()))
            .await
            .map_err(|error| anyhow!("the extraction task failed: {error}"))??;
        if cancel.is_cancelled() {
            bail!(CANCELLED);
        }
        for file in &missing {
            let (from, to) = (staging.join(&file.name), target.join(&file.name));
            patiently(|| std::fs::rename(&from, &to))
                .await
                .map_err(|error| anyhow!("Could not finish installing {} {}: {error}", entry.name, entry.version))?;
            model_integrity::mark_verified(model_integrity::intern(&file.name, file.size, &file.sha256), &to);
        }
        let record = serde_json::to_vec_pretty(&RuntimeRecord::from_entry(entry))?;
        super::write_atomically(&target.join(RECORD), &record)?;
        Ok(())
    }
    .await;
    if let Err(cleanup) = remove_dir(&staging) {
        log::warn!("[runtime] could not remove {}: {cleanup:#}", staging.display());
    }
    completed.map(|()| target)
}

/// Fills `staging` with the checked files and the record.
async fn stage(
    client: &reqwest::Client,
    staging: &Path,
    entry: &RuntimeEntry,
    signer: Option<&'static str>,
    cancel: &CancellationToken,
    progress: &mut impl FnMut(u64, u64),
) -> Result<()> {
    let archive = staging.join(ARCHIVE);
    download(client, &archive, entry, cancel, progress).await?;
    let (from, into, files, token) = (archive.clone(), staging.to_path_buf(), entry.files.clone(), cancel.clone());
    let name = entry.name.clone();
    tokio::task::spawn_blocking(move || extract(&from, &into, &files, &name, signer, &|| token.is_cancelled()))
        .await
        .map_err(|error| anyhow!("the extraction task failed: {error}"))??;
    patiently(|| std::fs::remove_file(&archive))
        .await
        .map_err(|error| anyhow!("Could not delete the {} archive: {error}", entry.name))?;
    if cancel.is_cancelled() {
        bail!(CANCELLED);
    }
    let record = serde_json::to_vec_pretty(&RuntimeRecord::from_entry(entry))?;
    super::write_atomically(&staging.join(RECORD), &record)?;
    Ok(())
}

/// Downloads the archive to `path`, hashing it as it streams in. A mismatch
/// deletes it (`Check::finish`).
async fn download(
    client: &reqwest::Client,
    path: &Path,
    entry: &RuntimeEntry,
    cancel: &CancellationToken,
    progress: &mut impl FnMut(u64, u64),
) -> Result<()> {
    let pinned = model_integrity::intern(&format!("{} {} archive", entry.name, entry.version), entry.archive.size, &entry.archive.sha256);
    let total = entry.archive.size;
    let response = tokio::select! {
        _ = cancel.cancelled() => bail!(CANCELLED),
        result = tokio::time::timeout(STALL, client.get(&entry.archive.url).send()) => result
            .map_err(|_| anyhow!("Could not download {}: no answer for 30 seconds", entry.name))?
            // reqwest's error names the URL, which is the catalog's, not a signed one.
            .map_err(|error| anyhow!("Could not download {}: {error}", entry.name))?,
    };
    if !response.status().is_success() {
        bail!("Could not download {}: the server answered {}", entry.name, response.status());
    }
    let mut check = model_integrity::Check::new(pinned);
    let mut writer = tokio::io::BufWriter::with_capacity(8 << 20, tokio::fs::File::create(path).await?);
    let mut written = 0u64;
    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => bail!(CANCELLED),
            next = tokio::time::timeout(STALL, stream.next()) => next,
        };
        let chunk = match next {
            Err(_) => bail!("Could not download {}: no data for 30 seconds", entry.name),
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|error| anyhow!("Could not download {}: {error}", entry.name))?,
        };
        check.update(&chunk)?;
        writer.write_all(&chunk).await?;
        written += chunk.len() as u64;
        progress(written, total);
    }
    writer.flush().await?;
    drop(writer);
    if written != total {
        bail!("Could not download {}: stopped at {written} of {total} bytes", entry.name);
    }
    check.finish(path)
}

/// Copies each pinned file out of the archive into `into`, checking it as
/// it is written and, with `signer`, each library's signature, before it is
/// marked verified. Names in the archive are only looked up, never used as
/// paths: a file lands under its catalog `name`, which the schema keeps to
/// one safe path segment.
fn extract(
    archive: &Path,
    into: &Path,
    files: &[schema::RuntimeFile],
    name: &str,
    signer: Option<&str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<()> {
    use std::io::{Read, Write};
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)
        .map_err(|error| anyhow!("The {name} archive cannot be read: {error}"))?;
    let mut buffer = vec![0u8; 1 << 20];
    for file in files {
        let pinned = model_integrity::intern(&file.name, file.size, &file.sha256);
        let mut source = zip
            .by_name(&file.path)
            .map_err(|error| anyhow!("The {name} archive lacks {}: {error}", file.path))?;
        let path = into.join(&file.name);
        let mut check = model_integrity::Check::new(pinned);
        let mut output = std::io::BufWriter::new(std::fs::File::create(&path)?);
        loop {
            if cancelled() {
                bail!(CANCELLED);
            }
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            check.update(&buffer[..read])?;
            output.write_all(&buffer[..read])?;
        }
        output.flush()?;
        drop(output);
        check.finish(&path)?;
        if let Some(signer) = signer.filter(|_| file.name.to_ascii_lowercase().ends_with(".dll")) {
            super::authenticode::check_signed_by(&path, signer)?;
        }
        model_integrity::mark_verified(pinned, &path);
    }
    Ok(())
}

/// Removes the version in `dir`: the record first, so a removal stopped
/// halfway leaves files nothing trusts.
pub fn remove_version(dir: &Path) -> Result<()> {
    match std::fs::remove_file(dir.join(RECORD)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(anyhow!("Could not delete {}: {error}", dir.display())),
    }
    remove_dir(dir)
}

fn remove_dir(dir: &Path) -> Result<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow!("Could not delete {}: {error}", dir.display())),
    }
}

/// Removes everything under `root` but the version folders in `keep`: other
/// versions, staging folders a crash left, and with `keep` empty the whole
/// runtime. Best effort: a folder that cannot go now (its libraries are
/// loaded by another process) is logged and tried again next time.
pub fn prune_in(root: &Path, keep: &[PathBuf]) {
    let Ok(read) = std::fs::read_dir(root) else { return };
    for item in read.flatten() {
        let path = item.path();
        if keep.contains(&path) {
            continue;
        }
        let removed = if item.file_type().is_ok_and(|kind| kind.is_dir()) {
            remove_version(&path)
        } else {
            std::fs::remove_file(&path).map_err(|error| anyhow!("Could not delete {}: {error}", path.display()))
        };
        match removed {
            Ok(()) => log::info!("[runtime] removed {}", path.display()),
            Err(error) => log::warn!("[runtime] {error:#}; trying again at the next start"),
        }
    }
    if keep.is_empty() {
        let _ = std::fs::remove_dir(root);
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    pub fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    /// A zip with `files` (path in the archive, content) and an entry for
    /// it whose pins match them; `version` names the version.
    pub fn archive_and_entry(version: &str, files: &[(&str, &str, &[u8])], url: &str) -> (Vec<u8>, RuntimeEntry) {
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (path, _, content) in files {
            zip.start_file(*path, zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(content).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        let entry = RuntimeEntry {
            id: schema::OPENVINO_GENAI.to_string(),
            name: "OpenVINO GenAI".to_string(),
            description: String::new(),
            version: version.to_string(),
            platform: schema::platform().to_string(),
            api: crate::whisper_engine::openvino::genai::API_LEVEL,
            license: schema::License { name: "Test".to_string(), url: "https://example.com/license".to_string() },
            archive: schema::RuntimeArchive { url: url.to_string(), size: bytes.len() as u64, sha256: sha256(&bytes) },
            files: files
                .iter()
                .map(|(path, name, content)| schema::RuntimeFile {
                    name: name.to_string(),
                    path: path.to_string(),
                    size: content.len() as u64,
                    sha256: sha256(content),
                })
                .collect(),
            min_app_version: None,
        };
        (bytes, entry)
    }

    /// The two libraries the binding opens and a licence, under a root
    /// folder as Intel's archive has them.
    pub fn openvino_files(salt: u8) -> Vec<(&'static str, &'static str, Vec<u8>)> {
        vec![
            ("root/runtime/bin/openvino_genai_c.dll", "openvino_genai_c.dll", vec![salt; 300]),
            ("root/runtime/bin/openvino_c.dll", "openvino_c.dll", vec![salt.wrapping_add(1); 200]),
            ("root/docs/EULA.txt", "openvino-EULA.txt", b"licence".to_vec()),
        ]
    }

    /// A local server that answers every request with `body`; returns its URL.
    pub async fn serve(body: Vec<u8>) -> String {
        crate::model_integrity::testing::serve_once(body).await
    }

    /// A local server that answers one request with a redirect to `location`.
    pub async fn serve_redirect(location: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/runtime.zip", listener.local_addr().unwrap());
        let head = format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                match stream.read(&mut buffer).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => request.extend_from_slice(&buffer[..read]),
                }
            }
            let _ = stream.write_all(head.as_bytes()).await;
        });
        url
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn entry_with(version: &str, salt: u8) -> (Vec<u8>, RuntimeEntry) {
        let files = openvino_files(salt);
        let borrowed: Vec<(&str, &str, &[u8])> = files.iter().map(|(path, name, content)| (*path, *name, content.as_slice())).collect();
        archive_and_entry(version, &borrowed, "https://example.com/runtime.zip")
    }

    async fn install(root: &Path, bytes: Vec<u8>, entry: &mut RuntimeEntry, cancel: &CancellationToken) -> Result<PathBuf> {
        entry.archive.url = serve(bytes).await;
        install_into(&Fetch::Local(reqwest::Client::new()), root, entry, cancel, |_, _| {}).await
    }

    fn leftovers(root: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(root)
            .map(|read| read.flatten().map(|item| item.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        names.sort();
        names
    }

    #[tokio::test]
    async fn an_install_extracts_only_the_pinned_files_verified_and_deletes_the_archive() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let files = openvino_files(7);
        let pinned: Vec<(&str, &str, &[u8])> = files.iter().map(|(path, name, content)| (*path, *name, content.as_slice())).collect();
        let (_, mut entry) = archive_and_entry("2026.4.1.0", &pinned, "https://example.com/runtime.zip");
        // The archive holds more than the catalog pins: the rest stays in it.
        let mut whole = pinned.clone();
        whole.push(("root/runtime/bin/openvino_intel_npu_plugin.dll", "npu.dll", b"npu"));
        let (archive, _) = archive_and_entry("2026.4.1.0", &whole, "https://example.com/runtime.zip");
        entry.archive.size = archive.len() as u64;
        entry.archive.sha256 = sha256(&archive);
        let mut reported = Vec::new();
        entry.archive.url = serve(archive).await;
        let dir = install_into(&Fetch::Local(reqwest::Client::new()), &root, &entry, &CancellationToken::new(), |done, total| reported.push((done, total)))
            .await
            .unwrap();

        assert_eq!(dir, root.join("2026.4.1.0"));
        for (_, name, content) in &files {
            assert_eq!(&std::fs::read(dir.join(name)).unwrap(), content);
        }
        assert!(!dir.join("npu.dll").exists());
        assert!(!dir.join(ARCHIVE).exists());
        assert_eq!(reported.last(), Some(&(entry.archive.size, entry.archive.size)));
        assert_eq!(leftovers(&root), ["2026.4.1.0"]);
        let installed = installed_in(&root);
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].record, RuntimeRecord::from_entry(&entry));
        assert_eq!(installed[0].record.size(), 300 + 200 + 7);

        // A file changed since its check: the version no longer counts.
        std::fs::write(dir.join("openvino_c.dll"), b"changed").unwrap();
        assert!(installed_in(&root).is_empty());
    }

    #[tokio::test]
    async fn an_archive_that_is_not_the_pinned_one_installs_nothing() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (mut bytes, mut entry) = entry_with("2026.4.1.0", 3);
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        let error = install(&root, bytes, &mut entry, &CancellationToken::new()).await.unwrap_err();
        assert!(error.to_string().contains("integrity check"), "{error:#}");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));
        assert!(installed_in(&root).is_empty());
    }

    #[tokio::test]
    async fn a_file_that_does_not_match_its_pin_installs_nothing() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (bytes, mut entry) = entry_with("2026.4.1.0", 3);
        // The archive is the pinned one, but the catalog pins another library.
        entry.files[1].sha256 = sha256(b"something else");
        let error = install(&root, bytes, &mut entry, &CancellationToken::new()).await.unwrap_err();
        assert!(error.to_string().contains("openvino_c.dll"), "{error:#}");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));

        // A file the archive lacks fails the same way.
        let (bytes, mut entry) = entry_with("2026.4.1.0", 3);
        entry.files[0].path = "root/elsewhere/openvino_genai_c.dll".to_string();
        let error = install(&root, bytes, &mut entry, &CancellationToken::new()).await.unwrap_err();
        assert!(error.to_string().contains("lacks root/elsewhere/openvino_genai_c.dll"), "{error:#}");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));
    }

    #[tokio::test]
    async fn a_cancelled_install_leaves_nothing_and_the_installed_version_alone() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (bytes, mut old) = entry_with("2026.4.1.0", 1);
        let installed = install(&root, bytes, &mut old, &CancellationToken::new()).await.unwrap();

        let (bytes, mut new) = entry_with("2026.5.0.0", 2);
        new.archive.url = serve(bytes).await;
        let cancel = CancellationToken::new();
        // Cancelled as the first bytes arrive: mid-way through the download.
        let error = install_into(&Fetch::Local(reqwest::Client::new()), &root, &new, &cancel, |_, _| cancel.cancel()).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);
        assert_eq!(leftovers(&root), ["2026.4.1.0"]);
        assert_eq!(installed_in(&root).iter().map(|version| version.dir.clone()).collect::<Vec<_>>(), [installed]);
    }

    #[tokio::test]
    async fn a_new_version_installs_beside_the_old_one_which_prune_then_removes() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (bytes, mut old) = entry_with("2026.4.1.0", 1);
        install(&root, bytes, &mut old, &CancellationToken::new()).await.unwrap();
        let (bytes, mut new) = entry_with("2026.5.0.0", 2);
        let new_dir = install(&root, bytes, &mut new, &CancellationToken::new()).await.unwrap();
        let versions: Vec<String> = installed_in(&root).into_iter().map(|version| version.record.version).collect();
        assert_eq!(versions, ["2026.5.0.0", "2026.4.1.0"]);

        // A staging folder a crash left goes with the old version.
        std::fs::create_dir_all(root.join(".staging-2026.6.0.0")).unwrap();
        std::fs::write(root.join(".staging-2026.6.0.0").join(ARCHIVE), b"half").unwrap();
        prune_in(&root, &[new_dir.clone()]);
        assert_eq!(leftovers(&root), ["2026.5.0.0"]);
        assert_eq!(installed_in(&root).len(), 1);

        // Installing a version that is there and verified fetches nothing.
        install_into(&Fetch::Local(reqwest::Client::new()), &root, &new, &CancellationToken::new(), |_, _| panic!("downloaded again"))
            .await
            .unwrap();

        prune_in(&root, &[]);
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn a_version_folder_left_unverified_is_replaced_by_the_install() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        std::fs::create_dir_all(root.join("2026.4.1.0")).unwrap();
        std::fs::write(root.join("2026.4.1.0").join("openvino_c.dll"), b"stale").unwrap();
        let (bytes, mut entry) = entry_with("2026.4.1.0", 4);
        let dir = install(&root, bytes, &mut entry, &CancellationToken::new()).await.unwrap();
        assert_eq!(std::fs::read(dir.join("openvino_c.dll")).unwrap(), vec![5u8; 200]);
        assert_eq!(installed_in(&root).len(), 1);
    }

    /// The same version as `entry_with(version, salt)`, pinning one file more
    /// (as the catalog added the NPU plugin), and the archive holding it.
    fn entry_with_more(version: &str, salt: u8) -> (Vec<u8>, RuntimeEntry) {
        let mut files = openvino_files(salt);
        files.push(("root/runtime/bin/openvino_intel_npu_plugin.dll", "openvino_intel_npu_plugin.dll", vec![salt; 90]));
        let borrowed: Vec<(&str, &str, &[u8])> = files.iter().map(|(path, name, content)| (*path, *name, content.as_slice())).collect();
        archive_and_entry(version, &borrowed, "https://example.com/runtime.zip")
    }

    #[tokio::test]
    async fn a_completion_adds_only_the_files_the_installed_version_lacks() {
        use std::os::windows::fs::OpenOptionsExt;
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (bytes, mut old) = entry_with("2026.4.1.0", 6);
        let dir = install(&root, bytes, &mut old, &CancellationToken::new()).await.unwrap();
        let before = std::fs::metadata(dir.join("openvino_c.dll")).unwrap().modified().unwrap();

        let (bytes, mut more) = entry_with_more("2026.4.1.0", 6);
        let missing = missing_files(&dir, &more).unwrap();
        assert_eq!(missing.iter().map(|file| file.name.as_str()).collect::<Vec<_>>(), ["openvino_intel_npu_plugin.dll"]);
        // As a loaded library: open without sharing. The completion does not touch it.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(dir.join("openvino_c.dll")).unwrap();
        more.archive.url = serve(bytes).await;
        let completed = complete_into(&Fetch::Local(reqwest::Client::new()), &root, &more, &CancellationToken::new(), |_, _| {})
            .await
            .unwrap();
        drop(held);

        assert_eq!(completed, dir);
        assert_eq!(std::fs::read(dir.join("openvino_intel_npu_plugin.dll")).unwrap(), vec![6u8; 90]);
        assert_eq!(std::fs::metadata(dir.join("openvino_c.dll")).unwrap().modified().unwrap(), before);
        assert_eq!(leftovers(&root), ["2026.4.1.0"]);
        let installed = installed_in(&root);
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].record, RuntimeRecord::from_entry(&more));
        assert_eq!(missing_files(&dir, &more).unwrap(), []);
        // Complete already: nothing is fetched.
        complete_into(&Fetch::Local(reqwest::Client::new()), &root, &more, &CancellationToken::new(), |_, _| panic!("downloaded again"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_completion_that_fails_or_is_cancelled_leaves_the_version_as_it_was() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (bytes, mut old) = entry_with("2026.4.1.0", 2);
        let dir = install(&root, bytes, &mut old, &CancellationToken::new()).await.unwrap();

        // The catalog pins the new file otherwise than the archive holds it.
        let (bytes, mut more) = entry_with_more("2026.4.1.0", 2);
        more.files[3].sha256 = sha256(b"another build");
        more.archive.url = serve(bytes.clone()).await;
        let error = complete_into(&Fetch::Local(reqwest::Client::new()), &root, &more, &CancellationToken::new(), |_, _| {})
            .await
            .unwrap_err();
        assert!(error.to_string().contains("openvino_intel_npu_plugin.dll"), "{error:#}");

        let (_, mut more) = entry_with_more("2026.4.1.0", 2);
        more.archive.url = serve(bytes).await;
        let cancel = CancellationToken::new();
        let error = complete_into(&Fetch::Local(reqwest::Client::new()), &root, &more, &cancel, |_, _| cancel.cancel()).await.unwrap_err();
        assert_eq!(error.to_string(), CANCELLED);

        assert_eq!(leftovers(&root), ["2026.4.1.0"]);
        assert!(!dir.join("openvino_intel_npu_plugin.dll").exists());
        assert_eq!(installed_in(&root)[0].record, RuntimeRecord::from_entry(&old));
    }

    #[tokio::test]
    async fn another_build_of_the_version_or_a_missing_one_is_not_completed() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (_, more) = entry_with_more("2026.4.1.0", 3);
        let error = complete_into(&Fetch::Local(reqwest::Client::new()), &root, &more, &CancellationToken::new(), |_, _| panic!("downloaded"))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("is not installed"), "{error:#}");

        // Installed with other bytes for a file both pin: not a part of the entry.
        let (bytes, mut old) = entry_with("2026.4.1.0", 4);
        let dir = install(&root, bytes, &mut old, &CancellationToken::new()).await.unwrap();
        assert!(missing_files(&dir, &more).is_none());
        assert!(complete_into(&Fetch::Local(reqwest::Client::new()), &root, &more, &CancellationToken::new(), |_, _| panic!("downloaded"))
            .await
            .is_err());
        assert_eq!(installed_in(&root)[0].record, RuntimeRecord::from_entry(&old));
    }

    #[test]
    fn a_record_naming_a_path_outside_its_folder_is_not_trusted() {
        let dir = tempfile::tempdir().unwrap();
        let record = RuntimeRecord {
            id: "openvino-genai".to_string(),
            version: "1.0.0".to_string(),
            api: 1,
            files: vec![RecordFile { name: "../x.dll".to_string(), size: 1, sha256: sha256(b"x") }],
        };
        std::fs::write(dir.path().join(RECORD), serde_json::to_vec(&record).unwrap()).unwrap();
        assert_eq!(verified(dir.path()), None);
    }

    #[tokio::test]
    async fn the_vendor_install_refuses_an_archive_off_the_pinned_host_before_any_request() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (_, mut entry) = entry_with("2026.4.1.0", 1);
        for url in [
            "https://example.com/runtime.zip",
            "https://storage.openvinotoolkit.org.example.com/runtime.zip",
            "http://storage.openvinotoolkit.org/runtime.zip",
            "https://storage.openvinotoolkit.org:8443/runtime.zip",
        ] {
            entry.archive.url = url.to_string();
            let error = install_into(&Fetch::Vendor, &root, &entry, &CancellationToken::new(), |_, _| panic!("downloaded"))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("not on https://storage.openvinotoolkit.org/"), "{url}: {error:#}");
        }
        assert!(!root.exists());
    }

    #[test]
    fn a_redirect_may_go_only_to_https_on_the_pinned_host() {
        let allowed = |url: &str| redirect_allowed(&reqwest::Url::parse(url).unwrap(), "storage.openvinotoolkit.org");
        assert!(allowed("https://storage.openvinotoolkit.org/repositories/x.zip"));
        assert!(allowed("https://STORAGE.openvinotoolkit.org/x.zip"));
        assert!(!allowed("http://storage.openvinotoolkit.org/x.zip"));
        assert!(!allowed("https://storage.openvinotoolkit.org:444/x.zip"));
        assert!(!allowed("https://user@storage.openvinotoolkit.org/x.zip"));
        assert!(!allowed("https://cdn.openvinotoolkit.org/x.zip"));
        assert!(!allowed("https://storage.openvinotoolkit.org.example.com/x.zip"));
    }

    #[tokio::test]
    async fn a_redirect_off_the_pinned_host_fails_the_download() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (_, mut entry) = entry_with("2026.4.1.0", 1);
        entry.archive.url = serve_redirect("https://example.com/runtime.zip").await;
        let client = reqwest::Client::builder().no_proxy().redirect(redirect_policy("storage.openvinotoolkit.org")).build().unwrap();
        let error = install_into(&Fetch::Local(client), &root, &entry, &CancellationToken::new(), |_, _| {}).await.unwrap_err();
        assert!(format!("{error:#}").contains("a redirect left https://storage.openvinotoolkit.org/"), "{error:#}");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));
    }

    #[tokio::test]
    async fn a_library_without_its_publishers_signature_installs_nothing() {
        let data = tempfile::tempdir().unwrap();
        let root = root_in(data.path(), "openvino-genai");
        let (bytes, mut entry) = entry_with("2026.4.1.0", 1);
        entry.archive.url = serve(bytes).await;
        let fetch = Fetch::LocalSigned(reqwest::Client::new(), "Intel Corporation");
        let error = install_into(&fetch, &root, &entry, &CancellationToken::new(), |_, _| {}).await.unwrap_err();
        assert!(error.to_string().contains("openvino_genai_c.dll does not carry a valid signature of Intel Corporation"), "{error:#}");
        assert!(leftovers(&root).is_empty(), "{:?}", leftovers(&root));
    }

    #[tokio::test]
    async fn a_rename_or_deletion_waits_out_a_file_held_open() {
        use std::os::windows::fs::OpenOptionsExt;
        let data = tempfile::tempdir().unwrap();
        let (from, to) = (data.path().join(".staging-1.0.0"), data.path().join("1.0.0"));
        std::fs::create_dir_all(&from).unwrap();
        // As an antivirus scan holds a fresh library: no sharing at all.
        let hold = |path: &Path| std::fs::OpenOptions::new().write(true).create(true).share_mode(0).open(path).unwrap();
        let held = hold(&from.join("openvino.dll"));
        assert!(std::fs::rename(&from, &to).is_err(), "Windows renamed a folder holding an open file");
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            drop(held);
        });
        patiently(|| std::fs::rename(&from, &to)).await.unwrap();
        release.join().unwrap();
        assert!(to.join("openvino.dll").exists());

        let archive = to.join(ARCHIVE);
        let held = hold(&archive);
        assert!(std::fs::remove_file(&archive).is_err());
        let release = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            drop(held);
        });
        patiently(|| std::fs::remove_file(&archive)).await.unwrap();
        release.join().unwrap();
        assert!(!archive.exists());
    }
}
