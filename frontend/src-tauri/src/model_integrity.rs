//! Checks that a downloaded model is exactly the file it was pinned to.
//!
//! Ported from leyvanah/Talkkeeper, `frontend/src-tauri/src/model_integrity.rs`
//! at commit ad314e3, MIT License, Copyright (c) 2026 leyvanah. Protocol adds
//! the diarization tables, the size bound and resume support of [`Check`], and
//! the verification markers described below.
//!
//! Models are parsed by native code — ggml, ONNX Runtime, llama.cpp — whose
//! file parsers have had memory-safety bugs. A model fetched from a mutable
//! `resolve/main` URL with nothing checked is therefore code from whoever
//! controls that repository today. Every URL below names a commit, and every
//! file its size and SHA-256.
//!
//! # Where the pins come from (checked 2026-10-25)
//!
//! - Hugging Face: `https://huggingface.co/api/models/<repo>/tree/<commit>?recursive=1`
//!   lists each file's `size` and, for LFS files, `lfs.oid`, the SHA-256 of
//!   the content. Files kept in git directly (Parakeet `vocab.txt`, the
//!   Nemotron license) were downloaded from the pinned commit and hashed; their
//!   git blob ids match the tree's `oid`. `nemo128.onnx` was downloaded too, to
//!   confirm that the LFS oid is the SHA-256 of the bytes Hugging Face serves.
//!   The Whisper, Parakeet and summary pins agree with Talkkeeper's table; the
//!   Nemotron pins predate this module.
//! - Pyannote/WeSpeaker: no byte-identical upstream copy of the two ONNX
//!   exports exists, so the repair download takes all three files from this
//!   repository at commit 76e9939, where they are the copies bundled in
//!   `resources/diarization/`. The pins are their SHA-256, the same values the
//!   previous fork's release assets carried.
//!
//! # Models that are already installed
//!
//! Hashing gigabytes at startup would hold up the app, so startup checks only
//! the exact size. A download is hashed while it streams in, and a match writes
//! a `<file>.verified` marker beside the file with the pin and the file's size
//! and modification time. [`ensure_verified`] runs before a model is loaded: a
//! valid marker costs two metadata reads, while a file without one — installed
//! by an older build, or changed since — is hashed once, off the async runtime.
//! A file that does not match is deleted at every stage. Diarization models
//! keep their own checks (`diarization/download.rs`, `nemotron.rs`) and use no
//! markers.

use anyhow::{anyhow, Result};
use sha2::{Digest, Sha256};
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

// --- Whisper (ggerganov/whisper.cpp) ---------------------------------------

pub const WHISPER_BASE: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";

pub const WHISPER: &[Pinned] = &[
    pin("ggml-tiny.bin", 77_691_713, "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"),
    pin("ggml-base.bin", 147_951_465, "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe"),
    pin("ggml-small.bin", 487_601_967, "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"),
    pin("ggml-medium.bin", 1_533_763_059, "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208"),
    pin("ggml-large-v3-turbo.bin", 1_624_555_275, "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"),
    pin("ggml-large-v3.bin", 3_095_033_483, "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2"),
    pin("ggml-tiny-q5_1.bin", 32_152_673, "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7"),
    pin("ggml-base-q5_1.bin", 59_707_625, "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"),
    pin("ggml-small-q5_1.bin", 190_085_487, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"),
    pin("ggml-medium-q5_0.bin", 539_212_467, "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f"),
    pin("ggml-large-v3-turbo-q5_0.bin", 574_041_195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
    pin("ggml-large-v3-q5_0.bin", 1_081_140_203, "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1"),
];

/// The pin of the Whisper model `name`, stored as `ggml-<name>.bin`.
pub fn whisper_model(name: &str) -> Option<&'static Pinned> {
    find(WHISPER, &format!("ggml-{name}.bin"))
}

// --- Parakeet (istupakov/parakeet-tdt-0.6b-*-onnx) --------------------------

pub const PARAKEET_V2_BASE: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/0bbb45a3365852604aef28b538a8f066f4ccaa85";
pub const PARAKEET_V3_BASE: &str =
    "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce";

/// The INT8 exports, the only Parakeet variants the app offers.
pub const PARAKEET_V2_INT8: &[Pinned] = &[
    pin("encoder-model.int8.onnx", 652_184_014, "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155"),
    pin("decoder_joint-model.int8.onnx", 8_998_286, "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3"),
    pin("nemo128.onnx", 139_764, "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
    pin("vocab.txt", 9_384, "ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d"),
];

pub const PARAKEET_V3_INT8: &[Pinned] = &[
    pin("encoder-model.int8.onnx", 652_183_999, "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09"),
    pin("decoder_joint-model.int8.onnx", 18_202_004, "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70"),
    pin("nemo128.onnx", 139_764, "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f"),
    pin("vocab.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
];

/// The pinned source and files of the Parakeet model directory `name`.
pub fn parakeet_model(name: &str) -> Option<(&'static str, &'static [Pinned])> {
    match name {
        "parakeet-tdt-0.6b-v2-int8" => Some((PARAKEET_V2_BASE, PARAKEET_V2_INT8)),
        "parakeet-tdt-0.6b-v3-int8" => Some((PARAKEET_V3_BASE, PARAKEET_V3_INT8)),
        _ => None,
    }
}

// --- Summary models (GGUF) --------------------------------------------------

/// Pinned URL and content of each built-in summary model. `file` is the name
/// on disk, which for the Gemma models differs from the name in the URL.
pub const SUMMARY: &[(&str, Pinned)] = &[
    (
        "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
        pin("Qwen3.5-2B-Q4_K_M.gguf", 1_280_835_840, "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223"),
    ),
    (
        "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf",
        pin("Qwen3.5-4B-Q4_K_M.gguf", 2_740_937_888, "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4"),
    ),
    (
        "https://huggingface.co/bartowski/google_gemma-3-4b-it-GGUF/resolve/71506238f970075ca85125cd749c28b1b0eee84e/google_gemma-3-4b-it-Q4_K_M.gguf",
        pin("gemma-3-4b-it-Q4_K_M.gguf", 2_489_758_112, "4996030242583a40aa151ff93f49ed787ac8c25e4120c3ae4588b2e2a7d1ae94"),
    ),
    (
        "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/116f76234503685a98f572982177b11d44ec8ff1/google_gemma-3-1b-it-Q8_0.gguf",
        pin("gemma-3-1b-it-Q8_0.gguf", 1_069_306_624, "375e12a4a18929a641f9744b060d4a7cf4e279530750555828ec0c117870bc96"),
    ),
];

/// The pinned URL and content of the built-in summary model stored as `file`.
pub fn summary_model(file: &str) -> Option<(&'static str, &'static Pinned)> {
    SUMMARY
        .iter()
        .find(|(_, pinned)| pinned.file == file)
        .map(|(url, pinned)| (*url, pinned))
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
    pub async fn resume(pinned: &'static Pinned, path: &Path) -> Result<Self> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            let mut check = Self::new(pinned);
            check.read(&path)?;
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
        Err(discard(self.pinned, path, self.bytes, &actual))
    }

    fn read(&mut self, path: &Path) -> Result<()> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        // Heap buffer: this runs on a blocking thread, but keep it off any stack.
        let mut buffer = vec![0u8; 1 << 20];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                return Ok(());
            }
            self.update(&buffer[..read])?;
        }
    }
}

/// Deletes `path` and its marker and describes why.
fn discard(pinned: &Pinned, path: &Path, bytes: u64, sha256: &str) -> anyhow::Error {
    let _ = std::fs::remove_file(path);
    clear_mark(path);
    if bytes == pinned.size {
        anyhow!(
            "{} failed its integrity check and was deleted: its SHA-256 is {}, expected {}. Download it again.",
            pinned.file,
            sha256,
            pinned.sha256
        )
    } else {
        anyhow!(
            "{} failed its integrity check and was deleted: it has {} bytes, expected {}. Download it again.",
            pinned.file,
            bytes,
            pinned.size
        )
    }
}

/// Hashes a file already on disk against its pin, off the async runtime. A
/// mismatch deletes the file.
pub async fn verify_file(pinned: &'static Pinned, path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let size = std::fs::metadata(&path)?.len();
        if size != pinned.size {
            return Err(discard(pinned, &path, size, ""));
        }
        let mut check = Check::new(pinned);
        check.read(&path)?;
        check.finish(&path)
    })
    .await?
}

// --- Verification markers ---------------------------------------------------

fn marker_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".verified");
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

/// Removes the marker of `path`, for code that deletes or rewrites the file.
pub fn clear_mark(path: &Path) {
    let _ = std::fs::remove_file(marker_path(path));
}

fn is_marked(pinned: &Pinned, path: &Path) -> bool {
    marker_line(pinned, path)
        .is_some_and(|line| std::fs::read_to_string(marker_path(path)).is_ok_and(|found| found == line))
}

/// Makes sure `path` is the pinned file before native code parses it. A file
/// with a valid marker is trusted; any other is hashed once and marked, or
/// deleted when it does not match.
pub async fn ensure_verified(pinned: &'static Pinned, path: &Path) -> Result<()> {
    if is_marked(pinned, path) {
        return Ok(());
    }
    log::info!("Checking {} against its pinned SHA-256 before first use", path.display());
    verify_file(pinned, path).await?;
    mark_verified(pinned, path);
    Ok(())
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
        WHISPER
            .iter()
            .chain(PARAKEET_V2_INT8)
            .chain(PARAKEET_V3_INT8)
            .chain(PYANNOTE)
            .chain(SUMMARY.iter().map(|(_, pinned)| pinned))
            .chain(NEMOTRON.iter().map(|(_, pinned)| pinned))
    }

    fn every_url() -> Vec<String> {
        let mut urls: Vec<String> = WHISPER.iter().map(|p| format!("{WHISPER_BASE}/{}", p.file)).collect();
        urls.extend(PARAKEET_V2_INT8.iter().map(|p| format!("{PARAKEET_V2_BASE}/{}", p.file)));
        urls.extend(PARAKEET_V3_INT8.iter().map(|p| format!("{PARAKEET_V3_BASE}/{}", p.file)));
        urls.extend(PYANNOTE.iter().map(|p| format!("{PYANNOTE_BASE}/{}", p.file)));
        urls.extend(SUMMARY.iter().chain(NEMOTRON).map(|(url, _)| url.to_string()));
        urls
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
        let mut check = Check::resume(&HELLO, &path).await.unwrap();
        check.update(b"llo").unwrap();
        std::fs::write(&path, b"hello").unwrap();
        check.finish(&path).unwrap();

        // A damaged prefix fails even though the streamed tail is right.
        std::fs::write(&path, b"HE").unwrap();
        let mut check = Check::resume(&HELLO, &path).await.unwrap();
        check.update(b"llo").unwrap();
        std::fs::write(&path, b"HEllo").unwrap();
        assert!(check.finish(&path).is_err());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn verify_file_rejects_size_and_hash_mismatches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, b"hello").unwrap();
        verify_file(&HELLO, &path).await.unwrap();

        std::fs::write(&path, b"hello!").unwrap();
        let error = verify_file(&HELLO, &path).await.unwrap_err().to_string();
        assert!(error.contains("it has 6 bytes, expected 5"), "{error}");
        assert!(!path.exists());

        std::fs::write(&path, b"jello").unwrap();
        assert!(verify_file(&HELLO, &path).await.is_err());
        assert!(!path.exists());
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
    #[ignore = "Downloads about 0.3 MB from Hugging Face and GitHub"]
    async fn small_pinned_files_match_what_their_sources_serve() {
        use futures_util::StreamExt;
        let dir = tempfile::tempdir().unwrap();
        let sources = [
            (format!("{PARAKEET_V2_BASE}/vocab.txt"), find(PARAKEET_V2_INT8, "vocab.txt").unwrap()),
            (format!("{PARAKEET_V3_BASE}/vocab.txt"), find(PARAKEET_V3_INT8, "vocab.txt").unwrap()),
            (format!("{PARAKEET_V3_BASE}/nemo128.onnx"), find(PARAKEET_V3_INT8, "nemo128.onnx").unwrap()),
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
        let resume = Check::resume(&HELLO, &path);
        assert!(std::mem::size_of_val(&resume) < 4096);
    }
}
