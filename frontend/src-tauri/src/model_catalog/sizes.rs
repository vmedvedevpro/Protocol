//! Download sizes of catalog models, read from Hugging Face.
//!
//! The catalog names a model's files, not their sizes: a size written there
//! would only drift from what Hugging Face serves. A model list asks for the
//! sizes it lacks when it is shown ([`fill`], through the
//! `model_catalog_request_sizes` command): one tree listing per repository
//! (and pinned revision) at the commit its entries resolve to now, in the
//! background, while the list shows without them. The listings are kept per
//! repository and commit in `sizes.json` beside the cached catalog, so later
//! lists show sizes at once, and the daily or manual check reads them again
//! ([`refresh`]). A size that was never read (offline, rate-limited, a
//! repository that is gone) is unknown and shown as nothing.
//!
//! Display only: a download resolves its files when it starts and checks the
//! bytes against that listing, and an installed model shows the size of its
//! own files (its install record or the 0.3.0 pins).

use super::huggingface::{self, HubError};
use super::schema::Entry;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A repository that could not be listed is not asked again for this long,
/// so a list shown again and again while offline sends nothing new.
const RETRY_AFTER: Duration = Duration::from_secs(10 * 60);

/// Which listing an entry's sizes come from: its repository and its pinned
/// revision (`None`: the default branch).
type Key = (String, Option<String>);

fn key(entry: &Entry) -> Key {
    (entry.repo.clone(), entry.revision.clone())
}

/// The files of a repository at one commit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Listing {
    repo: String,
    #[serde(default)]
    revision: Option<String>,
    commit: String,
    /// Every file listed in the folders asked for, by path in the
    /// repository, with its size in bytes.
    files: BTreeMap<String, u64>,
}

impl Listing {
    fn key(&self) -> Key {
        (self.repo.clone(), self.revision.clone())
    }

    /// The bytes of `entry`'s files; `None` when one of them was not listed.
    fn size(&self, entry: &Entry) -> Option<u64> {
        entry.files.iter().map(|file| self.files.get(&file.path).copied()).sum()
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Stored {
    listings: Vec<Listing>,
}

#[derive(Default)]
struct Sizes {
    /// Where the listings are kept; `None` keeps them in memory (tests).
    file: Option<PathBuf>,
    listings: Vec<Listing>,
    /// Changes whenever a size may have changed, so Settings lists again.
    version: u64,
    /// Listings being read now, so a list shown twice asks once.
    asking: HashSet<Key>,
    /// When a listing last failed, for [`RETRY_AFTER`].
    failed: HashMap<Key, Instant>,
}

impl Sizes {
    fn get(&self, entry: &Entry) -> Option<u64> {
        self.listings.iter().find(|listing| listing.key() == key(entry))?.size(entry)
    }

    /// Keeps `listing` in place of the one with its key; returns whether
    /// anything changed.
    fn put(&mut self, listing: Listing) -> bool {
        match self.listings.iter_mut().find(|known| known.key() == listing.key()) {
            Some(known) if *known == listing => false,
            Some(known) => {
                *known = listing;
                true
            }
            None => {
                self.listings.push(listing);
                true
            }
        }
    }

    fn save(&mut self) {
        self.version += 1;
        let Some(file) = &self.file else { return };
        let stored = Stored { listings: self.listings.clone() };
        let result = serde_json::to_vec_pretty(&stored)
            .map_err(std::io::Error::from)
            .and_then(|bytes| super::write_atomically(file, &bytes));
        if let Err(error) = result {
            log::warn!("[model catalog] could not keep the model sizes in {}: {error}", file.display());
        }
    }
}

static SIZES: Lazy<Mutex<Sizes>> = Lazy::new(Mutex::default);

fn lock(sizes: &Mutex<Sizes>) -> MutexGuard<'_, Sizes> {
    sizes.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_stored(file: &Path) -> Vec<Listing> {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .map(|stored| stored.listings)
        .unwrap_or_default()
}

/// Reads the listings kept in `dir` by earlier runs. Called once at launch.
pub fn load(dir: &Path) {
    let file = dir.join("sizes.json");
    let mut sizes = lock(&SIZES);
    sizes.listings = read_stored(&file);
    sizes.file = Some(file);
}

/// Changes whenever a size may have changed.
pub fn version() -> u64 {
    lock(&SIZES).version
}

/// The bytes a download of `entry` fetches, once its repository was listed.
pub fn download_size(entry: &Entry) -> Option<u64> {
    lock(&SIZES).get(entry)
}

/// The listings `entries` use, each with the folders their files are in.
fn groups<'a>(entries: impl IntoIterator<Item = &'a Entry>) -> Vec<(Key, Vec<String>)> {
    let mut groups: Vec<(Key, Vec<String>)> = Vec::new();
    for entry in entries {
        let index = match groups.iter().position(|(known, _)| *known == key(entry)) {
            Some(index) => index,
            None => {
                groups.push((key(entry), Vec::new()));
                groups.len() - 1
            }
        };
        for file in &entry.files {
            let dir = file.path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
            if !groups[index].1.contains(&dir) {
                groups[index].1.push(dir);
            }
        }
    }
    groups
}

/// Lists a repository at the commit `key` resolves to now (its pin, or the
/// head of the default branch): one tree request per folder, which is the
/// repository root for every model so far.
async fn list(client: &reqwest::Client, hub: &str, key: &Key, dirs: &[String]) -> Result<Listing, HubError> {
    let (repo, revision) = key;
    let commit = match revision {
        Some(revision) => revision.clone(),
        None => huggingface::head_commit(client, hub, repo).await?,
    };
    let mut files = BTreeMap::new();
    for dir in dirs {
        files.extend(huggingface::file_sizes(client, hub, repo, &commit, dir).await?);
    }
    Ok(Listing { repo: repo.clone(), revision: revision.clone(), commit, files })
}

/// Reads `wanted` one listing at a time and keeps what was read; returns
/// whether any size changed. Every key in `wanted` is in `asking`.
async fn read(sizes: &Mutex<Sizes>, client: &reqwest::Client, hub: &str, wanted: Vec<(Key, Vec<String>)>) -> bool {
    let mut changed = false;
    for (key, dirs) in wanted {
        let result = list(client, hub, &key, &dirs).await;
        let mut sizes = lock(sizes);
        sizes.asking.remove(&key);
        match result {
            Ok(listing) => {
                sizes.failed.remove(&key);
                changed |= sizes.put(listing);
            }
            Err(error) => {
                log::warn!("[model catalog] could not read the file sizes of {}: {error}", key.0);
                sizes.failed.insert(key, Instant::now());
            }
        }
    }
    if changed {
        lock(sizes).save();
    }
    changed
}

async fn fill_in(sizes: &Mutex<Sizes>, client: &reqwest::Client, hub: &str, entries: &[Entry]) -> bool {
    let wanted: Vec<(Key, Vec<String>)> = {
        let mut sizes = lock(sizes);
        let now = Instant::now();
        let missing: Vec<Key> = entries.iter().filter(|entry| sizes.get(entry).is_none()).map(key).collect();
        let wanted: Vec<_> = groups(entries)
            .into_iter()
            .filter(|(key, _)| missing.contains(key))
            .filter(|(key, _)| sizes.failed.get(key).map_or(true, |at| now.duration_since(*at) >= RETRY_AFTER))
            .filter(|(key, _)| !sizes.asking.contains(key))
            .collect();
        sizes.asking.extend(wanted.iter().map(|(key, _)| key.clone()));
        wanted
    };
    read(sizes, client, hub, wanted).await
}

/// Reads the sizes of `entries` that are not known yet (a model list being
/// shown); returns whether any size changed. A repository that failed is
/// asked again only after [`RETRY_AFTER`].
pub async fn fill(client: &reqwest::Client, hub: &str, entries: &[Entry]) -> bool {
    fill_in(&SIZES, client, hub, entries).await
}

async fn refresh_in(sizes: &Mutex<Sizes>, client: &reqwest::Client, hub: &str, entries: &[Entry]) -> bool {
    let (wanted, forgot) = {
        let mut sizes = lock(sizes);
        let used = groups(entries);
        let before = sizes.listings.len();
        sizes.listings.retain(|listing| used.iter().any(|(key, _)| *key == listing.key()));
        let forgot = sizes.listings.len() != before;
        if forgot {
            sizes.save();
        }
        let wanted: Vec<_> = used
            .into_iter()
            .filter(|(key, _)| sizes.listings.iter().any(|listing| listing.key() == *key))
            .filter(|(key, _)| !sizes.asking.contains(key))
            .collect();
        sizes.asking.extend(wanted.iter().map(|(key, _)| key.clone()));
        (wanted, forgot)
    };
    read(sizes, client, hub, wanted).await || forgot
}

/// Reads again every listing that `entries` use and forgets the others: the
/// daily or manual check, so sizes follow new commits. Returns whether any
/// size changed.
pub async fn refresh(client: &reqwest::Client, hub: &str, entries: &[Entry]) -> bool {
    refresh_in(&SIZES, client, hub, entries).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::schema::Engine;
    use crate::model_catalog::testing::{entry_for, Hub};

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";

    fn whisper(id: &str) -> Entry {
        entry_for(Engine::Whisper, id, "owner/whisper")
    }

    #[tokio::test]
    async fn sizes_are_listed_once_per_repository_and_kept() {
        let mut hub = Hub::new();
        hub.repo("owner/whisper", OLD).lfs_file("ggml-tiny.bin", &[1u8; 10]).lfs_file("ggml-base.bin", &[2u8; 20]);
        let hub = hub.serve().await;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sizes.json");
        let sizes = Mutex::new(Sizes { file: Some(file.clone()), ..Sizes::default() });
        let entries = [whisper("tiny"), whisper("base")];
        let client = huggingface::client();

        assert_eq!(lock(&sizes).get(&entries[0]), None);
        assert!(fill_in(&sizes, &client, &hub.url, &entries).await);
        assert_eq!(lock(&sizes).get(&entries[0]), Some(10));
        assert_eq!(lock(&sizes).get(&entries[1]), Some(20));
        // One commit and one tree request for both models.
        assert_eq!(hub.requests("/api/models/owner/whisper"), 1);
        assert_eq!(hub.requests(&format!("/api/models/owner/whisper/tree/{OLD}")), 1);

        // Known now: a list shown again asks nothing.
        assert!(!fill_in(&sizes, &client, &hub.url, &entries).await);
        assert_eq!(hub.requests(&format!("/api/models/owner/whisper/tree/{OLD}")), 1);
        assert_eq!(lock(&sizes).version, 1);
        // Kept for the next launch.
        assert_eq!(read_stored(&file), lock(&sizes).listings);
    }

    #[tokio::test]
    async fn a_pinned_revision_is_listed_at_its_commit_and_failures_wait() {
        let mut hub = Hub::new();
        // The head is NEW (the last commit added); the pinned OLD is listed.
        hub.repo("owner/whisper", OLD).lfs_file("ggml-tiny.bin", &[1u8; 10]);
        hub.repo("owner/whisper", NEW).lfs_file("ggml-tiny.bin", &[1u8; 99]);
        let hub = hub.serve().await;
        let sizes = Mutex::new(Sizes::default());
        let client = huggingface::client();
        let mut pinned = whisper("tiny");
        pinned.revision = Some(OLD.to_string());
        let gone = entry_for(Engine::Whisper, "tiny", "owner/gone");

        assert!(fill_in(&sizes, &client, &hub.url, &[pinned.clone(), gone.clone()]).await);
        assert_eq!(lock(&sizes).get(&pinned), Some(10));
        assert_eq!(lock(&sizes).get(&gone), None);
        assert_eq!(hub.requests("/api/models/owner/gone"), 1);
        // An unknown size stays unknown, and is not asked again at once.
        assert!(!fill_in(&sizes, &client, &hub.url, &[gone.clone()]).await);
        assert_eq!(hub.requests("/api/models/owner/gone"), 1);
        // A file the listing lacks leaves the size unknown.
        let mut other = pinned.clone();
        other.files[0].path = "ggml-missing.bin".to_string();
        assert_eq!(lock(&sizes).get(&other), None);
    }

    #[tokio::test]
    async fn the_check_reads_known_sizes_again_and_forgets_unused_ones() {
        let sizes = Mutex::new(Sizes::default());
        let client = huggingface::client();
        let tiny = whisper("tiny");
        let mut first = Hub::new();
        first.repo("owner/whisper", OLD).lfs_file("ggml-tiny.bin", &[1u8; 10]);
        let first = first.serve().await;
        assert!(fill_in(&sizes, &client, &first.url, &[tiny.clone()]).await);

        let mut moved = Hub::new();
        moved.repo("owner/whisper", NEW).lfs_file("ggml-tiny.bin", &[1u8; 30]);
        let moved = moved.serve().await;
        assert!(refresh_in(&sizes, &client, &moved.url, &[tiny.clone()]).await);
        assert_eq!(lock(&sizes).get(&tiny), Some(30));
        assert_eq!(lock(&sizes).listings[0].commit, NEW);

        // Never listed: the check does not ask for it.
        let parakeet = entry_for(Engine::Parakeet, "parakeet-tdt-0.6b-v3-int8", "owner/parakeet");
        assert!(!refresh_in(&sizes, &client, &moved.url, &[tiny.clone(), parakeet]).await);
        assert_eq!(moved.requests("/api/models/owner/parakeet"), 0);
        // No entry uses the repository any more.
        assert!(refresh_in(&sizes, &client, &moved.url, &[]).await);
        assert!(lock(&sizes).listings.is_empty());
    }
}
