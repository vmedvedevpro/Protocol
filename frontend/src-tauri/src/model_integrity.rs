//! Checks that a downloaded model is exactly the file it was pinned to.
//!
//! Ported from leyvanah/Talkkeeper, `frontend/src-tauri/src/model_integrity.rs`
//! at commit ad314e3, MIT License, Copyright (c) 2026 leyvanah. Protocol adds
//! the diarization tables, the size bound and resume support of [`Check`], and
//! the verification markers described below.
//!
//! Models are parsed by native code — ggml, ONNX Runtime, llama.cpp — whose
//! file parsers have had memory-safety bugs, so no model file is used before
//! its size and SHA-256 match a pin.
//!
//! # Where the pins come from
//!
//! - Transcription and summary models (#50, owner decision 2026-10-27): from
//!   Hugging Face at run time, as Ollama and LM Studio do. `crate::model_catalog`
//!   lists the repositories and files; `model_catalog::huggingface` resolves a
//!   repository's current commit (or the entry's pinned one), reads each
//!   file's size and SHA-256 (`lfs.oid`) from the tree listing at that commit
//!   and downloads from `resolve/<commit>/<path>`, so the bytes cannot change
//!   mid-download; files kept in Git are fetched and checked against their
//!   blob id first. Pins made this way are [`intern`]ed. The install record
//!   (`model_catalog::installed`) keeps what was verified; models installed by
//!   0.3.x are checked against the 0.3.0 pins kept there.
//! - Diarization models stay pinned in this file and change only with app
//!   releases; saved voice profiles and thresholds depend on them.
//!   - Nemotron (checked 2026-10-25): `https://huggingface.co/api/models/<repo>/tree/<commit>?recursive=1`
//!     lists each file's `size` and, for LFS files, `lfs.oid`, the SHA-256 of
//!     the content. The license, kept in Git, was downloaded from the pinned
//!     commit and hashed; its blob id matches the tree's `oid`.
//!   - Pyannote/WeSpeaker: no byte-identical upstream copy of the two ONNX
//!     exports exists, so the repair download takes all three files from this
//!     repository at commit 76e9939, where they are the copies bundled in
//!     `resources/diarization/`. The pins are their SHA-256, the same values
//!     the previous fork's release assets carried.
//!
//! # Models that are already installed
//!
//! Hashing gigabytes at startup would hold up the app, so startup checks only
//! the exact size. A download is hashed while it streams in, and a match writes
//! a `<file>.verified` marker beside the file with the pin and the file's size
//! and modification time. [`ensure_verified`] runs before a model is loaded: a
//! valid marker costs two metadata reads, while a file without one — installed
//! by an older build, or changed since — is hashed once, off the async runtime.
//! A full-size file whose content does not match is deleted at every stage. A
//! file on disk of another size is only refused: it may be a partial download
//! kept for resume, or one that a download is writing right now. Diarization
//! models keep their own checks (`diarization/download.rs`, `nemotron.rs`) and
//! use no markers.

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// What a file must be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pinned {
    /// Name of the file on disk.
    pub file: &'static str,
    pub size: u64,
    pub sha256: &'static str,
}

const fn pin(file: &'static str, size: u64, sha256: &'static str) -> Pinned {
    Pinned { file, size, sha256 }
}

/// A pin made at run time (`crate::model_catalog`). `Check` and the markers
/// hold `&'static` pins, so each distinct pin is allocated once and kept for
/// the life of the process; a session sees a few dozen at most.
pub fn intern(file: &str, size: u64, sha256: &str) -> &'static Pinned {
    static PINS: std::sync::Mutex<Vec<&'static Pinned>> = std::sync::Mutex::new(Vec::new());
    let mut pins = PINS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(pinned) = pins.iter().find(|pinned| pinned.file == file && pinned.size == size && pinned.sha256 == sha256) {
        return pinned;
    }
    let pinned: &'static Pinned = Box::leak(Box::new(Pinned {
        file: Box::leak(file.to_string().into_boxed_str()),
        size,
        sha256: Box::leak(sha256.to_string().into_boxed_str()),
    }));
    pins.push(pinned);
    pinned
}

// --- Speaker diarization ----------------------------------------------------

/// The Pyannote/WeSpeaker files bundled in `resources/diarization/`, served
/// from this repository at a fixed commit for the Settings repair download.
pub const PYANNOTE_BASE: &str =
    "https://raw.githubusercontent.com/vmedvedevpro/Protocol/76e9939e425f0b90fb62d6dd2032e8284fa0c19f/frontend/src-tauri/resources/diarization";

pub const PYANNOTE: &[Pinned] = &[
    pin("segmentation-3.0-fp16.onnx", 2_977_738, "b0acba8e4cc30e8ec2bd33075ce95f282d66acab86fb155860d8deddbfacd30c"),
    pin("wespeaker-resnet34-LM.onnx", 26_544_003, "992a5632618f11644608dbfbd28d401cd8480713207dc2db9af1c4cfc2c8652e"),
    pin("xvec_transform.npz", 134_376, "325f1ce8e48f7e55e9c8aa47e05d2766b7c48c4b25b8de8dd751e7a4cc5fbe8f"),
];

/// NVIDIA Nemotron-3 Diarization (altunenes/parakeet-rs) and its model
/// license, which is saved under another name.
pub const NEMOTRON: &[(&str, Pinned)] = &[
    (
        "https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization/LICENSE",
        pin("Nemotron-LICENSE.txt", 2_660, "14cf93aed5ee7c72516170ecb65fb6d7e54ef19217d328c8b00b78eaf61c8b36"),
    ),
    (
        "https://huggingface.co/altunenes/parakeet-rs/resolve/4d2a8bc71f5c896ec40faa59732e6716295edaf2/nemotron-3-diarization/nemotron3_diar_v3.onnx",
        pin("nemotron3_diar_v3.onnx", 400_506_656, "915e4fa23b0192ed9fadeb1cdd26847df986d50c92012d177be28d0343bbe03a"),
    ),
];

/// The pin for `file` in `table`.
pub fn find(table: &'static [Pinned], file: &str) -> Option<&'static Pinned> {
    table.iter().find(|pinned| pinned.file == file)
}

// --- Checking ---------------------------------------------------------------

/// Why a file is not the one it was pinned to. Callers that react differently
/// to these cases find them with `anyhow::Error::downcast_ref`.
#[derive(Debug)]
pub enum IntegrityError {
    /// A file on disk has another size than its pin. It is kept: it may be a
    /// partial download waiting to resume, or one being written right now.
    WrongSize { file: &'static str, size: u64, expected: u64 },
    /// The server announced another length than the pin. Raised before
    /// anything is written, so no file was touched.
    ServerSize { file: &'static str, size: u64, expected: u64 },
    /// The content does not match the pin. The file was deleted, unless
    /// `undeleted` holds the error that kept it on disk.
    Mismatch { file: &'static str, detail: String, undeleted: Option<String> },
    /// Hashing stopped because the download that asked for it was cancelled;
    /// the file is kept and not marked.
    Cancelled { file: &'static str },
}

impl fmt::Display for IntegrityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The UI tells the outcomes apart by "was deleted", "could not be
        // deleted" and "Nothing was deleted" (DownloadProgressToast.tsx,
        // recording_commands.rs).
        match self {
            Self::WrongSize { file, size, expected } if size < expected => write!(
                f,
                "{file} is not fully downloaded: it has {size} of {expected} bytes. Finish its download first."
            ),
            Self::WrongSize { file, size, expected } => write!(
                f,
                "{file} is larger than its pinned size: it has {size} bytes, expected {expected}. Download it again."
            ),
            Self::ServerSize { file, size, expected } => write!(
                f,
                "{file} failed its integrity check: the server sent a file of {size} bytes, expected {expected}. Nothing was deleted; retry the download."
            ),
            Self::Mismatch { file, detail, undeleted: None } => {
                write!(f, "{file} failed its integrity check and was deleted: {detail}. Download it again.")
            }
            Self::Mismatch { file, detail, undeleted: Some(error) } => write!(
                f,
                "{file} failed its integrity check and could not be deleted ({error}): {detail}. Close any program that has it open, then download it again."
            ),
            Self::Cancelled { file } => write!(f, "Checking {file} stopped: its download was cancelled"),
        }
    }
}

impl std::error::Error for IntegrityError {}

/// A SHA-256 fed as the bytes arrive, bounded by the pinned size.
pub struct Check {
    pinned: &'static Pinned,
    hasher: Sha256,
    bytes: u64,
}

impl Check {
    pub fn new(pinned: &'static Pinned) -> Self {
        Self { pinned, hasher: Sha256::new(), bytes: 0 }
    }

    /// Continues a download whose first bytes are already in `path`. They are
    /// hashed once here, off the async runtime, so only the rest streams in.
    /// `cancelled` is polled between 1 MiB reads: re-reading gigabytes must
    /// not hold up Cancel (see [`IntegrityError::Cancelled`]).
    pub async fn resume(
        pinned: &'static Pinned,
        path: &Path,
        cancelled: impl Fn() -> bool + Send + 'static,
    ) -> Result<Self> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut check = Self::new(pinned);
            check.read(&path, &cancelled)?;
            Ok(check)
        })
        .await?
    }

    /// Adds `chunk`, or refuses it when it would run past the pinned size.
    pub fn update(&mut self, chunk: &[u8]) -> Result<()> {
        if chunk.len() as u64 > self.pinned.size - self.bytes {
            return Err(anyhow!(
                "{} failed its integrity check: the download exceeds its pinned size of {} bytes",
                self.pinned.file,
                self.pinned.size
            ));
        }
        self.hasher.update(chunk);
        self.bytes += chunk.len() as u64;
        Ok(())
    }

    /// Compares what arrived with the pin. On a mismatch `path` is deleted, so
    /// a file that is not the model never sits where the model is looked for.
    pub fn finish(self, path: &Path) -> Result<()> {
        let actual = format!("{:x}", self.hasher.finalize());
        if self.bytes == self.pinned.size && actual == self.pinned.sha256 {
            return Ok(());
        }
        Err(discard(self.pinned, path, self.bytes, &actual).into())
    }

    fn read(&mut self, path: &Path, cancelled: &dyn Fn() -> bool) -> Result<()> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        // Heap buffer: this runs on a blocking thread, but keep it off any stack.
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            if cancelled() {
                return Err(IntegrityError::Cancelled { file: self.pinned.file }.into());
            }
            let read = file.read(&mut buffer)?;
            if read == 0 {
                return Ok(());
            }
            self.update(&buffer[..read])?;
        }
    }
}

/// Deletes `path` and its marker and describes why. A file that cannot be
/// deleted (another process holds it open without delete sharing) gets a
/// rejection marker instead, so discovery does not list it as installed.
fn discard(pinned: &'static Pinned, path: &Path, bytes: u64, sha256: &str) -> IntegrityError {
    let undeleted = match std::fs::remove_file(path) {
        Ok(()) => None,
        // Gone already, for example deleted by a concurrent check.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(error.to_string()),
    };
    clear_mark(path);
    if undeleted.is_some() {
        reject(pinned, path);
    }
    let detail = if bytes == pinned.size {
        format!("its SHA-256 is {}, expected {}", sha256, pinned.sha256)
    } else {
        format!("it has {} bytes, expected {}", bytes, pinned.size)
    };
    IntegrityError::Mismatch { file: pinned.file, detail, undeleted }
}

/// Hashes a file already on disk against its pin, off the async runtime. Only
/// a full-size file that does not match is deleted; a file of another size is
/// refused with [`IntegrityError::WrongSize`] and kept.
pub async fn verify_file(pinned: &'static Pinned, path: &Path) -> Result<()> {
    verify(pinned, path, || false).await
}

async fn verify(pinned: &'static Pinned, path: &Path, cancelled: impl Fn() -> bool + Send + 'static) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let wrong_size = |size| IntegrityError::WrongSize { file: pinned.file, size, expected: pinned.size };
        let size = std::fs::metadata(&path)?.len();
        if size != pinned.size {
            return Err(wrong_size(size).into());
        }
        let mut check = Check::new(pinned);
        check.read(&path, &cancelled)?;
        if check.bytes != pinned.size {
            // The file shrank while it was read: a download has taken it over.
            return Err(wrong_size(check.bytes).into());
        }
        check.finish(&path)
    })
    .await?
}

// --- Verification markers ---------------------------------------------------

fn marker_path(path: &Path) -> PathBuf {
    sibling(path, ".verified")
}

fn rejection_path(path: &Path) -> PathBuf {
    sibling(path, ".rejected")
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// The marker content for `path` as it is now. Size and modification time tie
/// the marker to this exact file: rewriting the file invalidates it.
fn marker_line(pinned: &Pinned, path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{} {} {}\n", pinned.sha256, metadata.len(), modified))
}

/// Records that `path` matched `pinned`; call it once the file is closed.
/// Best effort: without a marker the file is hashed again before its next load.
pub fn mark_verified(pinned: &Pinned, path: &Path) {
    let written = marker_line(pinned, path).map(|line| std::fs::write(marker_path(path), line));
    if !matches!(written, Some(Ok(()))) {
        log::warn!(
            "Could not record the verification of {}; it will be hashed again before its next load",
            path.display()
        );
    }
}

/// Removes the markers of `path`, for code that deletes or rewrites the file.
pub fn clear_mark(path: &Path) {
    let _ = std::fs::remove_file(marker_path(path));
    let _ = std::fs::remove_file(rejection_path(path));
}

fn is_marked(pinned: &Pinned, path: &Path) -> bool {
    marker_line(pinned, path)
        .is_some_and(|line| std::fs::read_to_string(marker_path(path)).is_ok_and(|found| found == line))
}

/// Records that `path` failed its check but is still on disk. The marker is
/// tied to the file like a verification marker, so rewriting the file lifts it.
fn reject(pinned: &Pinned, path: &Path) {
    let written = marker_line(pinned, path).map(|line| std::fs::write(rejection_path(path), line));
    if !matches!(written, Some(Ok(()))) {
        log::warn!("Could not record that {} failed its integrity check", path.display());
    }
}

/// The reason to show instead of "installed" for a file that has its pinned
/// size but failed its check earlier and could not be deleted. Discovery,
/// which compares sizes only, would otherwise list it as available again.
pub fn rejection(pinned: &Pinned, path: &Path) -> Option<String> {
    let line = marker_line(pinned, path)?;
    let found = std::fs::read_to_string(rejection_path(path)).ok()?;
    (found == line).then(|| {
        format!(
            "{} failed its integrity check and could not be deleted. Close any program that has it open, then download it again.",
            pinned.file
        )
    })
}

/// Makes sure `path` is the pinned file before native code parses it. A file
/// with a valid marker is trusted; any other full-size file is hashed once and
/// marked, or deleted when it does not match. A file of another size is
/// refused and kept (see [`verify_file`]).
pub async fn ensure_verified(pinned: &'static Pinned, path: &Path) -> Result<()> {
    ensure_verified_cancellable(pinned, path, || false).await
}

/// [`ensure_verified`] for a download that can be cancelled while it checks a
/// file it already has: `cancelled` is polled between 1 MiB reads.
pub async fn ensure_verified_cancellable(
    pinned: &'static Pinned,
    path: &Path,
    cancelled: impl Fn() -> bool + Send + 'static,
) -> Result<()> {
    if is_marked(pinned, path) {
        return Ok(());
    }
    log::info!("Checking {} against its pinned SHA-256 before first use", path.display());
    verify(pinned, path, cancelled).await?;
    mark_verified(pinned, path);
    Ok(())
}

/// For download tests that run without the network: a pin for given bytes,
/// and a local server that sends them once.
#[cfg(test)]
pub(crate) mod testing {
    use super::Pinned;
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A pin that `bytes` match, stored as `file`.
    pub fn pin_of(file: &'static str, bytes: &[u8]) -> &'static Pinned {
        Box::leak(Box::new(Pinned {
            file,
            size: bytes.len() as u64,
            sha256: Box::leak(format!("{:x}", Sha256::digest(bytes)).into_boxed_str()),
        }))
    }

    /// Answers one HTTP request on a local port with `body`; returns the URL.
    pub async fn serve_once(body: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/model", listener.local_addr().unwrap());
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
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(&body).await;
        });
        url
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HELLO: Pinned = Pinned {
        file: "hello.txt",
        size: 5,
        sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    };

    fn every_pin() -> impl Iterator<Item = &'static Pinned> {
        PYANNOTE.iter().chain(NEMOTRON.iter().map(|(_, pinned)| pinned))
    }

    fn every_url() -> Vec<String> {
        let mut urls: Vec<String> = PYANNOTE.iter().map(|p| format!("{PYANNOTE_BASE}/{}", p.file)).collect();
        urls.extend(NEMOTRON.iter().map(|(url, _)| url.to_string()));
        urls
    }

    #[test]
    fn interning_a_pin_twice_returns_the_same_one() {
        let first = intern("model.bin", 5, HELLO.sha256);
        let second = intern(&String::from("model.bin"), 5, HELLO.sha256);
        assert!(std::ptr::eq(first, second));
        assert!(!std::ptr::eq(first, intern("model.bin", 6, HELLO.sha256)));
        assert_eq!(*first, Pinned { file: "model.bin", size: 5, sha256: HELLO.sha256 });
    }

    #[test]
    fn every_pin_is_a_well_formed_sha256() {
        for pinned in every_pin() {
            assert_eq!(pinned.sha256.len(), 64, "{}", pinned.file);
            assert!(pinned.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(pinned.size > 0);
        }
    }

    #[test]
    fn every_url_names_a_commit_and_none_uses_the_previous_forks_hosting() {
        let commit = |segment: &str| segment.len() == 40 && segment.bytes().all(|b| b.is_ascii_hexdigit());
        for url in every_url() {
            assert!(url.starts_with("https://"), "{url}");
            assert!(!url.contains("/resolve/main/") && !url.contains("TylerBuza"), "{url}");
            assert!(url.split('/').any(commit), "{url} is not pinned to a commit");
        }
    }

    #[test]
    fn streamed_chunks_matching_the_pin_pass() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hello").unwrap();

        let mut check = Check::new(&HELLO);
        check.update(b"hel").unwrap();
        check.update(b"lo").unwrap();
        check.finish(&path).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn a_hash_mismatch_of_the_right_size_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hellO").unwrap();

        let mut check = Check::new(&HELLO);
        check.update(b"hellO").unwrap();
        let error = check.finish(&path).unwrap_err().to_string();
        assert!(error.contains("failed its integrity check and was deleted"), "{error}");
        assert!(error.contains("SHA-256"), "{error}");
        assert!(!path.exists());
    }

    #[test]
    fn a_truncated_download_deletes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hell").unwrap();

        let mut check = Check::new(&HELLO);
        check.update(b"hell").unwrap();
        let error = check.finish(&path).unwrap_err().to_string();
        assert!(error.contains("it has 4 bytes, expected 5"), "{error}");
        assert!(!path.exists());
    }

    #[test]
    fn bytes_past_the_pinned_size_are_refused() {
        let mut check = Check::new(&HELLO);
        check.update(b"hel").unwrap();
        assert!(check.update(b"lo!").unwrap_err().to_string().contains("exceeds its pinned size"));
        // The refused chunk is not counted, so the rest still completes the file.
        check.update(b"lo").unwrap();
    }

    #[tokio::test]
    async fn a_resumed_download_hashes_the_bytes_already_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"he").unwrap();
        let mut check = Check::resume(&HELLO, &path, || false).await.unwrap();
        check.update(b"llo").unwrap();
        std::fs::write(&path, b"hello").unwrap();
        check.finish(&path).unwrap();

        // A damaged prefix fails even though the streamed tail is right.
        std::fs::write(&path, b"HE").unwrap();
        let mut check = Check::resume(&HELLO, &path, || false).await.unwrap();
        check.update(b"llo").unwrap();
        std::fs::write(&path, b"HEllo").unwrap();
        assert!(check.finish(&path).is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn cancelling_stops_hashing_between_reads_and_keeps_the_file() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.bin");
        // Three 1 MiB reads; a full-size file whose hash does not match.
        let content = vec![7u8; 3 << 20];
        std::fs::write(&path, &content).unwrap();
        let pinned: &'static Pinned =
            Box::leak(Box::new(Pinned { file: "model.bin", size: content.len() as u64, sha256: HELLO.sha256 }));
        // Cancel arrives while the first megabyte is hashed.
        let cancel_after_one_read = || {
            let polls = Arc::new(AtomicUsize::new(0));
            let seen = polls.clone();
            (move || polls.fetch_add(1, Ordering::SeqCst) >= 1, seen)
        };

        let (cancelled, polls) = cancel_after_one_read();
        let error = ensure_verified_cancellable(pinned, &path, cancelled).await.unwrap_err();
        assert!(matches!(error.downcast_ref(), Some(IntegrityError::Cancelled { .. })), "{error}");
        assert_eq!(polls.load(Ordering::SeqCst), 2, "stopped after one read");
        // Neither deleted as a mismatch nor marked as verified.
        assert!(path.exists());
        assert!(!marker_path(&path).exists());

        let (cancelled, _) = cancel_after_one_read();
        let error = Check::resume(pinned, &path, cancelled).await.err().expect("cancelled");
        assert!(matches!(error.downcast_ref(), Some(IntegrityError::Cancelled { .. })), "{error}");
        assert!(path.exists());
    }

    #[tokio::test]
    async fn verify_file_keeps_a_file_of_another_size_and_deletes_a_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hello").unwrap();
        verify_file(&HELLO, &path).await.unwrap();

        // A partial download, or one being written, is refused but kept.
        std::fs::write(&path, b"hel").unwrap();
        let error = verify_file(&HELLO, &path).await.unwrap_err();
        assert!(matches!(error.downcast_ref(), Some(IntegrityError::WrongSize { size: 3, .. })), "{error}");
        assert!(error.to_string().contains("is not fully downloaded: it has 3 of 5 bytes"), "{error}");
        assert_eq!(std::fs::read(&path).unwrap(), b"hel");

        std::fs::write(&path, b"hello!").unwrap();
        let error = verify_file(&HELLO, &path).await.unwrap_err().to_string();
        assert!(error.contains("larger than its pinned size: it has 6 bytes, expected 5"), "{error}");
        assert!(path.exists());

        std::fs::write(&path, b"jello").unwrap();
        let error = verify_file(&HELLO, &path).await.unwrap_err();
        assert!(matches!(error.downcast_ref(), Some(IntegrityError::Mismatch { .. })), "{error}");
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_mismatch_that_cannot_be_deleted_says_so_and_stays_rejected() {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"jello").unwrap();
        // Another program holds the file open without delete sharing.
        let holder = std::fs::OpenOptions::new().read(true).share_mode(FILE_SHARE_READ).open(&path).unwrap();

        let error = ensure_verified(&HELLO, &path).await.unwrap_err();
        assert!(
            matches!(error.downcast_ref(), Some(IntegrityError::Mismatch { undeleted: Some(_), .. })),
            "{error}"
        );
        assert!(error.to_string().contains("failed its integrity check and could not be deleted ("), "{error}");
        assert!(!error.to_string().contains("was deleted"), "{error}");
        assert!(path.exists());
        // Discovery sees the full size; the rejection keeps it from listing the file.
        assert!(rejection(&HELLO, &path).unwrap().contains("could not be deleted"));

        drop(holder);
        let error = ensure_verified(&HELLO, &path).await.unwrap_err().to_string();
        assert!(error.contains("failed its integrity check and was deleted"), "{error}");
        assert!(!path.exists());
        assert!(!rejection_path(&path).exists());
    }

    #[test]
    fn a_wrong_length_from_the_server_says_nothing_was_deleted() {
        let error = IntegrityError::ServerSize { file: "hello.txt", size: 12, expected: 5 }.to_string();
        assert!(error.contains("failed its integrity check: the server sent a file of 12 bytes, expected 5"), "{error}");
        assert!(error.contains("Nothing was deleted"), "{error}");
    }

    #[tokio::test]
    async fn a_marker_skips_hashing_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hello").unwrap();
        ensure_verified(&HELLO, &path).await.unwrap();
        assert!(is_marked(&HELLO, &path));

        // A marker for another pin does not vouch for this one.
        const OTHER: Pinned = Pinned { sha256: "00", ..HELLO };
        assert!(!is_marked(&OTHER, &path));

        // Rewriting the file changes its modification time, so the marker no
        // longer applies and the new content is hashed and rejected.
        let marked = std::fs::metadata(&path).unwrap().modified().unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
        std::io::Write::write_all(&mut &file, b"jello").unwrap();
        file.set_modified(marked + std::time::Duration::from_secs(1)).unwrap();
        drop(file);
        assert!(!is_marked(&HELLO, &path));
        let error = ensure_verified(&HELLO, &path).await.unwrap_err().to_string();
        assert!(error.contains("failed its integrity check and was deleted"), "{error}");
        assert!(!path.exists());
        assert!(!marker_path(&path).exists());
    }

    /// Streams small pinned files from their real sources through `Check`.
    #[tokio::test]
    #[ignore = "Downloads about 0.1 MB from Hugging Face and GitHub"]
    async fn small_pinned_files_match_what_their_sources_serve() {
        use futures_util::StreamExt;
        let dir = tempfile::tempdir().unwrap();
        let sources = [
            (format!("{PYANNOTE_BASE}/xvec_transform.npz"), find(PYANNOTE, "xvec_transform.npz").unwrap()),
            (NEMOTRON[0].0.to_string(), &NEMOTRON[0].1),
        ];
        for (url, pinned) in sources {
            let response = reqwest::get(&url).await.unwrap().error_for_status().unwrap();
            let mut check = Check::new(pinned);
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                check.update(&chunk.unwrap()).unwrap();
            }
            check.finish(&dir.path().join(pinned.file)).unwrap_or_else(|e| panic!("{url}: {e}"));
        }
    }

    #[tokio::test]
    async fn verifying_a_file_keeps_futures_small() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hello").unwrap();
        // Download IPC futures are nested several times on Windows before they
        // are spawned; see docs/V0218_DOWNLOAD_FIX.md.
        let future = ensure_verified(&HELLO, &path);
        assert!(std::mem::size_of_val(&future) < 4096);
        future.await.unwrap();
        let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cancelled = move || flag.load(std::sync::atomic::Ordering::Acquire);
        let future = ensure_verified_cancellable(&HELLO, &path, cancelled.clone());
        assert!(std::mem::size_of_val(&future) < 4096);
        let resume = Check::resume(&HELLO, &path, cancelled);
        assert!(std::mem::size_of_val(&resume) < 4096);
    }
}
