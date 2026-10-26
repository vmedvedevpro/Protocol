//! The update cache: a downloaded payload kept until it is installed, and the
//! install-attempt marker that tells the next launch whether an install worked.
//!
//! Layout (Tauri's app cache folder, `…/updates/`):
//!
//! - `<version>.payload`: the verified installer or bundle archive;
//! - `<version>.json`: [`CachedUpdate`], the feed entry the payload belongs to,
//!   written after the payload, so a manifest always describes a complete file;
//! - `install-attempt.json`: [`InstallAttempt`], written just before an install;
//! - `updater.log`: see `journal.rs`.
//!
//! The payload is re-verified against its signature before it is used
//! (`restore` in `mod.rs`, and `Update::install` itself), so size and SHA-256
//! here only catch a truncated or replaced file early.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const MARKER: &str = "install-attempt.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedUpdate {
    pub version: String,
    /// The feed document, for `Updater::restore_update`.
    pub raw_json: serde_json::Value,
    pub size: u64,
    pub sha256: String,
    /// Unix ms.
    pub downloaded_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallAttempt {
    pub from: String,
    pub to: String,
    /// Unix ms.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttemptOutcome {
    /// This launch runs the version the install wanted.
    Updated { from: String },
    /// Still on the version the install started from.
    Incomplete { to: String },
    /// Neither (installed by hand meanwhile): forget it.
    Unrelated,
}

pub fn attempt_outcome(attempt: &InstallAttempt, running: &str) -> AttemptOutcome {
    if running == attempt.to {
        AttemptOutcome::Updated { from: attempt.from.clone() }
    } else if running == attempt.from {
        AttemptOutcome::Incomplete { to: attempt.to.clone() }
    } else {
        AttemptOutcome::Unrelated
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

pub struct Cache {
    dir: PathBuf,
}

impl Cache {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn payload_path(&self, version: &str) -> PathBuf {
        self.dir.join(format!("{version}.payload"))
    }

    fn manifest_path(&self, version: &str) -> PathBuf {
        self.dir.join(format!("{version}.json"))
    }

    /// Writes the payload, then its manifest, each through a temporary file and
    /// a rename. Removes every other cached version afterwards.
    pub fn store(&self, version: &str, raw_json: serde_json::Value, bytes: &[u8], now: i64) -> io::Result<CachedUpdate> {
        fs::create_dir_all(&self.dir)?;
        let entry = CachedUpdate {
            version: version.to_string(),
            raw_json,
            size: bytes.len() as u64,
            sha256: sha256_hex(bytes),
            downloaded_at: now,
        };
        write_atomic(&self.payload_path(version), bytes)?;
        let manifest = serde_json::to_vec_pretty(&entry).map_err(io::Error::other)?;
        write_atomic(&self.manifest_path(version), &manifest)?;
        self.remove_except(Some(version));
        Ok(entry)
    }

    /// The cached entries whose payload has the recorded size, newest download first.
    pub fn entries(&self) -> Vec<CachedUpdate> {
        let Ok(read) = fs::read_dir(&self.dir) else { return Vec::new() };
        let mut entries: Vec<CachedUpdate> = read
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .filter(|path| path.file_name().is_some_and(|name| name != MARKER))
            .filter_map(|path| serde_json::from_slice::<CachedUpdate>(&fs::read(path).ok()?).ok())
            .filter(|entry| {
                fs::metadata(self.payload_path(&entry.version)).is_ok_and(|meta| meta.len() == entry.size)
            })
            .collect();
        entries.sort_by(|a, b| b.downloaded_at.cmp(&a.downloaded_at));
        entries
    }

    /// The payload of `entry`, if it still has the recorded size and hash.
    pub fn read_payload(&self, entry: &CachedUpdate) -> io::Result<Vec<u8>> {
        let bytes = fs::read(self.payload_path(&entry.version))?;
        if bytes.len() as u64 != entry.size || sha256_hex(&bytes) != entry.sha256 {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "the cached update was changed on disk"));
        }
        Ok(bytes)
    }

    /// Deletes every cached payload and manifest except `keep`.
    pub fn remove_except(&self, keep: Option<&str>) {
        let Ok(read) = fs::read_dir(&self.dir) else { return };
        for path in read.flatten().map(|entry| entry.path()) {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else { continue };
            let Some((version, extension)) = name.rsplit_once('.') else { continue };
            let cached = matches!(extension, "payload" | "json" | "part") && name != MARKER;
            let version = version.trim_end_matches(".payload").trim_end_matches(".json");
            if cached && Some(version) != keep {
                if let Err(error) = fs::remove_file(&path) {
                    log::warn!("[updater] could not delete {}: {error}", path.display());
                }
            }
        }
    }

    pub fn write_attempt(&self, attempt: &InstallAttempt) -> io::Result<()> {
        fs::create_dir_all(&self.dir)?;
        let bytes = serde_json::to_vec_pretty(attempt).map_err(io::Error::other)?;
        write_atomic(&self.dir.join(MARKER), &bytes)
    }

    pub fn take_attempt(&self) -> Option<InstallAttempt> {
        let path = self.dir.join(MARKER);
        let attempt = serde_json::from_slice(&fs::read(&path).ok()?).ok();
        let _ = fs::remove_file(path);
        attempt
    }

    pub fn clear_attempt(&self) {
        let _ = fs::remove_file(self.dir.join(MARKER));
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let part = path.with_extension(format!(
        "{}.part",
        path.extension().and_then(|ext| ext.to_str()).unwrap_or_default()
    ));
    fs::write(&part, bytes)?;
    fs::rename(&part, path)
}

/// Windows: tauri-plugin-updater writes each installer to
/// `%TEMP%\<product>-<version>-updater-XXXXXX\` and never deletes it
/// (plugins-workspace #2132), about 130 MB per update. Called on the first
/// scheduler tick, after a relaunching installer has exited.
pub fn remove_installer_temp_dirs(temp: &Path, product: &str) -> usize {
    let prefix = format!("{product}-");
    let Ok(read) = fs::read_dir(temp) else { return 0 };
    let mut removed = 0;
    for entry in read.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let ours = name.starts_with(&prefix) && name.contains("-updater-");
        if ours && entry.file_type().is_ok_and(|kind| kind.is_dir()) && fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> (tempfile::TempDir, Cache) {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::new(dir.path().join("updates"));
        (dir, cache)
    }

    #[test]
    fn a_stored_payload_is_listed_and_read_back() {
        let (_dir, cache) = cache();
        let entry = cache.store("0.3.1", serde_json::json!({ "version": "0.3.1" }), b"payload", 5).unwrap();
        assert_eq!(cache.entries(), vec![entry.clone()]);
        assert_eq!(cache.read_payload(&entry).unwrap(), b"payload");
    }

    #[test]
    fn storing_a_version_removes_the_others() {
        let (_dir, cache) = cache();
        cache.store("0.3.1", serde_json::json!({}), b"old", 1).unwrap();
        cache.store("0.3.2", serde_json::json!({}), b"new", 2).unwrap();
        let versions: Vec<_> = cache.entries().into_iter().map(|entry| entry.version).collect();
        assert_eq!(versions, vec!["0.3.2"]);
        assert!(!cache.dir().join("0.3.1.payload").exists());
    }

    #[test]
    fn a_changed_or_truncated_payload_is_rejected() {
        let (_dir, cache) = cache();
        let entry = cache.store("0.3.1", serde_json::json!({}), b"payload", 5).unwrap();
        fs::write(cache.dir().join("0.3.1.payload"), b"PAYLOAD").unwrap();
        assert_eq!(cache.read_payload(&entry).unwrap_err().kind(), io::ErrorKind::InvalidData);
        fs::write(cache.dir().join("0.3.1.payload"), b"pay").unwrap();
        assert!(cache.entries().is_empty());
    }

    #[test]
    fn a_manifest_without_its_payload_is_ignored() {
        let (_dir, cache) = cache();
        cache.store("0.3.1", serde_json::json!({}), b"payload", 5).unwrap();
        fs::remove_file(cache.dir().join("0.3.1.payload")).unwrap();
        assert!(cache.entries().is_empty());
    }

    #[test]
    fn remove_except_keeps_the_marker_and_the_log() {
        let (_dir, cache) = cache();
        cache.store("0.3.1", serde_json::json!({}), b"payload", 5).unwrap();
        cache.write_attempt(&InstallAttempt { from: "0.3.0".into(), to: "0.3.1".into(), at: 1 }).unwrap();
        fs::write(cache.dir().join("updater.log"), b"line").unwrap();
        cache.remove_except(None);
        assert!(cache.entries().is_empty());
        assert!(cache.dir().join("updater.log").exists());
        assert!(cache.take_attempt().is_some());
        assert!(cache.take_attempt().is_none());
    }

    #[test]
    fn the_marker_tells_success_from_an_unfinished_install() {
        let attempt = InstallAttempt { from: "0.3.0".into(), to: "0.3.1".into(), at: 1 };
        assert_eq!(attempt_outcome(&attempt, "0.3.1"), AttemptOutcome::Updated { from: "0.3.0".into() });
        assert_eq!(attempt_outcome(&attempt, "0.3.0"), AttemptOutcome::Incomplete { to: "0.3.1".into() });
        assert_eq!(attempt_outcome(&attempt, "0.4.0"), AttemptOutcome::Unrelated);
    }

    #[test]
    fn only_this_products_installer_folders_are_removed() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["Protocol-0.3.1-updater-a1b2c3", "Protocol QA-0.3.1-updater-x", "Other-1.0-updater-y", "Protocol-notes"] {
            fs::create_dir(temp.path().join(name)).unwrap();
        }
        assert_eq!(remove_installer_temp_dirs(temp.path(), "Protocol"), 1);
        assert!(temp.path().join("Protocol QA-0.3.1-updater-x").exists());
        assert!(temp.path().join("Protocol-notes").exists());
    }

    #[test]
    fn hashes_are_lowercase_hex() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
