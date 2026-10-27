//! Resolves a catalog entry to exact bytes on Hugging Face.
//!
//! An entry names a repository and files, not a version. Resolving it reads
//! the repository's current commit (or takes the entry's pinned `revision`),
//! then the tree listing at that commit, which gives each file's size and, for
//! files kept in Git LFS, the SHA-256 of its content (`lfs.oid`). Downloads go
//! to `resolve/<commit>/<path>`, so the bytes cannot change in the middle of a
//! download, and are checked against that size and SHA-256 by
//! `crate::model_integrity::Check` as before.
//!
//! Small files kept in Git directly (Parakeet's `vocab.txt`) have no SHA-256
//! in the listing, only their Git blob id. They are fetched here, their blob
//! id is recomputed and compared, and their SHA-256 is taken from the bytes,
//! so every file gets a full pin before the engine downloads it.

use crate::model_integrity::{self, Pinned};
use anyhow::Result;
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::time::Duration;

use super::schema::{is_commit, is_sha256, Entry};

/// Where repositories are read from; tests pass a local server instead.
pub const HUB: &str = "https://huggingface.co";

/// Files Hugging Face keeps in Git directly are at most 10 MiB.
const SMALL_FILE_LIMIT: u64 = 10 << 20;
const MAX_TREE_PAGES: usize = 20;

/// A file of a resolved entry, ready for the engine's download.
#[derive(Debug, Clone)]
pub struct ResolvedFile {
    /// Name on disk.
    pub name: String,
    /// Path in the repository.
    pub path: String,
    pub url: String,
    pub pinned: &'static Pinned,
    /// The Git blob id from the listing; it identifies files kept outside LFS.
    pub git_oid: String,
}

/// An entry at one commit of its repository.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub repo: String,
    pub commit: String,
    pub files: Vec<ResolvedFile>,
}

impl Resolved {
    pub fn total_size(&self) -> u64 {
        self.files.iter().map(|file| file.pinned.size).sum()
    }
}

/// Why Hugging Face could not answer. The text is shown in Settings.
#[derive(Debug)]
pub enum HubError {
    Network(String),
    RateLimited,
    NotFound(String),
    Unexpected(String),
}

impl std::fmt::Display for HubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Network(detail) => {
                write!(f, "Couldn't reach Hugging Face. Check your connection, VPN, firewall, or proxy, then retry. Details: {detail}")
            }
            Self::RateLimited => write!(f, "Hugging Face is limiting requests right now. Try again in a few minutes."),
            Self::NotFound(what) => write!(f, "{what} was not found on Hugging Face."),
            Self::Unexpected(detail) => write!(f, "Hugging Face sent an unexpected answer: {detail}"),
        }
    }
}

impl std::error::Error for HubError {}

#[derive(Debug, Clone, Deserialize)]
struct ModelInfo {
    sha: String,
}

#[derive(Debug, Clone, Deserialize)]
struct Lfs {
    oid: String,
    size: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct TreeItem {
    #[serde(rename = "type")]
    kind: String,
    oid: String,
    size: u64,
    path: String,
    #[serde(default)]
    lfs: Option<Lfs>,
}

/// A client builder with the app's name. Tests talk to a local server, so
/// their clients bypass any system proxy.
pub fn builder() -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder().user_agent(concat!("Protocol/", env!("CARGO_PKG_VERSION")));
    if cfg!(test) {
        builder.no_proxy()
    } else {
        builder
    }
}

/// The client for the API and small files: short timeouts.
pub fn client() -> reqwest::Client {
    builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap_or_default()
}

pub fn download_url(hub: &str, repo: &str, commit: &str, path: &str) -> String {
    format!("{hub}/{repo}/resolve/{commit}/{path}")
}

async fn get(client: &reqwest::Client, url: &str, what: &str) -> Result<reqwest::Response, HubError> {
    let response = client.get(url).send().await.map_err(|error| HubError::Network(error.to_string()))?;
    match response.status() {
        status if status.is_success() => Ok(response),
        reqwest::StatusCode::TOO_MANY_REQUESTS => Err(HubError::RateLimited),
        // Hugging Face answers 401 for a repository that does not exist (or is
        // private or gated), 404 for a missing revision or path.
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::UNAUTHORIZED => Err(HubError::NotFound(what.to_string())),
        status => Err(HubError::Unexpected(format!("{status} for {url}"))),
    }
}

/// The commit the entry resolves to now: its pin, or the head of the
/// repository's default branch.
pub async fn current_commit(client: &reqwest::Client, hub: &str, entry: &Entry) -> Result<String, HubError> {
    if let Some(revision) = &entry.revision {
        return Ok(revision.clone());
    }
    let what = format!("The repository {}", entry.repo);
    let info: ModelInfo = get(client, &format!("{hub}/api/models/{}", entry.repo), &what)
        .await?
        .json()
        .await
        .map_err(|error| HubError::Unexpected(error.to_string()))?;
    if !is_commit(&info.sha) {
        return Err(HubError::Unexpected(format!("{} has no commit id", entry.repo)));
    }
    Ok(info.sha)
}

/// The listing of `dir` (the repository root when empty) at `commit`,
/// following `Link: <…>; rel="next"` pages.
async fn tree(client: &reqwest::Client, hub: &str, repo: &str, commit: &str, dir: &str) -> Result<Vec<TreeItem>, HubError> {
    let suffix = if dir.is_empty() { String::new() } else { format!("/{dir}") };
    let mut url = Some(format!("{hub}/api/models/{repo}/tree/{commit}{suffix}"));
    let mut items = Vec::new();
    let what = format!("{repo} at commit {commit}");
    for _ in 0..MAX_TREE_PAGES {
        let Some(page) = url.take() else { break };
        let response = get(client, &page, &what).await?;
        url = next_page(response.headers());
        let mut listed: Vec<TreeItem> =
            response.json().await.map_err(|error| HubError::Unexpected(error.to_string()))?;
        items.append(&mut listed);
    }
    Ok(items)
}

fn next_page(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let link = headers.get(reqwest::header::LINK)?.to_str().ok()?;
    link.split(',').find_map(|part| {
        let (target, params) = part.split_once(';')?;
        params
            .split(';')
            .any(|param| param.trim() == "rel=\"next\"")
            .then(|| target.trim().trim_start_matches('<').trim_end_matches('>').to_string())
    })
}

/// The Git blob id of `content`: SHA-1 over `blob <length>\0` and the bytes.
pub fn git_blob_id(content: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()).as_bytes());
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

/// A file of an entry as the listing at a commit shows it.
#[derive(Debug, Clone)]
pub struct Listed {
    /// Name on disk.
    pub name: String,
    pub size: u64,
    /// The SHA-256 of an LFS file; `None` for a file kept in Git.
    pub sha256: Option<String>,
    pub git_oid: String,
    item: TreeItem,
}

/// Lists the files of `entry` at `commit` without downloading any: what an
/// update check compares with the installed files.
pub async fn listing(client: &reqwest::Client, hub: &str, entry: &Entry, commit: &str) -> Result<Vec<Listed>> {
    let mut listings: Vec<(String, Vec<TreeItem>)> = Vec::new();
    let mut files = Vec::new();
    for file in &entry.files {
        let dir = file.path.rsplit_once('/').map_or("", |(dir, _)| dir).to_string();
        if !listings.iter().any(|(listed, _)| *listed == dir) {
            let items = tree(client, hub, &entry.repo, commit, &dir).await?;
            listings.push((dir.clone(), items));
        }
        let (_, items) = listings.iter().find(|(listed, _)| *listed == dir).expect("listed above");
        let item = items
            .iter()
            .find(|item| item.kind == "file" && item.path == file.path)
            .ok_or_else(|| HubError::NotFound(format!("{} in {} at commit {commit}", file.path, entry.repo)))?;
        let sha256 = match &item.lfs {
            Some(lfs) if lfs.size == item.size && is_sha256(&lfs.oid) => Some(lfs.oid.clone()),
            Some(_) => return Err(HubError::Unexpected(format!("the listing of {} is inconsistent", file.path)).into()),
            None => None,
        };
        files.push(Listed { name: file.name.clone(), size: item.size, sha256, git_oid: item.oid.clone(), item: item.clone() });
    }
    Ok(files)
}

/// Resolves `entry` at `commit`: every file's size and SHA-256.
pub async fn resolve_at(client: &reqwest::Client, hub: &str, entry: &Entry, commit: &str) -> Result<Resolved> {
    let mut files = Vec::new();
    for (file, listed) in entry.files.iter().zip(listing(client, hub, entry, commit).await?) {
        let url = download_url(hub, &entry.repo, commit, &file.path);
        let sha256 = match listed.sha256 {
            Some(sha256) => sha256,
            None => small_file_sha256(client, &url, &listed.item).await?,
        };
        files.push(ResolvedFile {
            name: file.name.clone(),
            path: file.path.clone(),
            url,
            pinned: model_integrity::intern(&file.name, listed.size, &sha256),
            git_oid: listed.git_oid,
        });
    }
    Ok(Resolved { repo: entry.repo.clone(), commit: commit.to_string(), files })
}

/// Resolves `entry` at the commit it points to now.
pub async fn resolve(client: &reqwest::Client, hub: &str, entry: &Entry) -> Result<Resolved> {
    let commit = current_commit(client, hub, entry).await?;
    resolve_at(client, hub, entry, &commit).await
}

/// Fetches a file kept in Git and checks its size and blob id against the
/// listing, so its SHA-256 can be trusted as much as an LFS file's.
async fn small_file_sha256(client: &reqwest::Client, url: &str, item: &TreeItem) -> Result<String> {
    if item.size > SMALL_FILE_LIMIT {
        return Err(HubError::Unexpected(format!("{} is large but not stored in LFS", item.path)).into());
    }
    let bytes = get(client, url, &item.path)
        .await?
        .bytes()
        .await
        .map_err(|error| HubError::Network(error.to_string()))?;
    if bytes.len() as u64 != item.size || git_blob_id(&bytes) != item.oid {
        return Err(anyhow::anyhow!(
            "{} failed its integrity check: Hugging Face sent {} bytes that do not match its listing. Nothing was saved; retry the download.",
            item.path,
            bytes.len()
        ));
    }
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::testing::{entry_for, Hub};

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    #[tokio::test]
    async fn an_unpinned_entry_follows_the_default_branch_and_pins_every_file() {
        let vocab = b"hello\nworld\n".to_vec();
        let mut hub = Hub::new();
        hub.repo("owner/model", COMMIT)
            .lfs_file("encoder-model.int8.onnx", &[1u8; 300])
            .lfs_file("decoder_joint-model.int8.onnx", &[2u8; 100])
            .lfs_file("nemo128.onnx", &[3u8; 50])
            .git_file("vocab.txt", &vocab);
        let hub = hub.serve().await;
        let entry = entry_for(super::super::schema::Engine::Parakeet, "parakeet-tdt-0.6b-v3-int8", "owner/model");

        let resolved = resolve(&client(), &hub.url, &entry).await.unwrap();
        assert_eq!(resolved.commit, COMMIT);
        assert_eq!(resolved.total_size(), 300 + 100 + 50 + vocab.len() as u64);
        let encoder = &resolved.files[0];
        assert_eq!(encoder.url, format!("{}/owner/model/resolve/{COMMIT}/encoder-model.int8.onnx", hub.url));
        assert_eq!(encoder.pinned.sha256, format!("{:x}", Sha256::digest([1u8; 300])));
        // The Git file was fetched once, checked against its blob id, hashed.
        let vocab_pin = resolved.files[3].pinned;
        assert_eq!(vocab_pin.sha256, format!("{:x}", Sha256::digest(&vocab)));
        assert_eq!(hub.requests(&format!("/owner/model/resolve/{COMMIT}/vocab.txt")), 1);
    }

    #[tokio::test]
    async fn a_pinned_revision_is_used_without_asking_for_the_branch() {
        let mut hub = Hub::new();
        hub.repo("owner/whisper", COMMIT).lfs_file("ggml-tiny.bin", b"ggml-weights");
        let hub = hub.serve().await;
        let mut entry = entry_for(super::super::schema::Engine::Whisper, "tiny", "owner/whisper");
        entry.revision = Some(COMMIT.to_string());

        let resolved = resolve(&client(), &hub.url, &entry).await.unwrap();
        assert_eq!(resolved.commit, COMMIT);
        assert_eq!(hub.requests("/api/models/owner/whisper"), 0);
        assert!(resolved.files[0].url.contains(&format!("/resolve/{COMMIT}/")));
    }

    #[tokio::test]
    async fn a_git_file_whose_bytes_do_not_match_the_listing_is_refused() {
        let mut hub = Hub::new();
        hub.repo("owner/model", COMMIT)
            .lfs_file("encoder-model.int8.onnx", &[1u8; 10])
            .lfs_file("decoder_joint-model.int8.onnx", &[2u8; 10])
            .lfs_file("nemo128.onnx", &[3u8; 10])
            .git_file_serving("vocab.txt", b"listed", b"served");
        let hub = hub.serve().await;
        let entry = entry_for(super::super::schema::Engine::Parakeet, "parakeet-tdt-0.6b-v3-int8", "owner/model");
        let error = resolve(&client(), &hub.url, &entry).await.unwrap_err().to_string();
        assert!(error.contains("vocab.txt failed its integrity check"), "{error}");
    }

    #[tokio::test]
    async fn missing_files_repositories_and_rate_limits_have_their_own_messages() {
        let mut hub = Hub::new();
        hub.repo("owner/whisper", COMMIT).lfs_file("ggml-other.bin", b"x");
        hub.status("/api/models/owner/busy", 429);
        let hub = hub.serve().await;
        let client = client();

        let entry = entry_for(super::super::schema::Engine::Whisper, "tiny", "owner/whisper");
        let error = resolve(&client, &hub.url, &entry).await.unwrap_err();
        assert!(matches!(error.downcast_ref(), Some(HubError::NotFound(what)) if what.starts_with("ggml-tiny.bin in owner/whisper")), "{error}");

        let gone = entry_for(super::super::schema::Engine::Whisper, "tiny", "owner/gone");
        let error = resolve(&client, &hub.url, &gone).await.unwrap_err();
        assert!(error.to_string().contains("The repository owner/gone was not found"), "{error}");

        let busy = entry_for(super::super::schema::Engine::Whisper, "tiny", "owner/busy");
        let error = resolve(&client, &hub.url, &busy).await.unwrap_err();
        assert!(matches!(error.downcast_ref(), Some(HubError::RateLimited)), "{error}");

        let offline = resolve(&client, "http://127.0.0.1:9", &entry).await.unwrap_err();
        assert!(offline.to_string().starts_with("Couldn't reach Hugging Face"), "{offline}");
    }

    #[test]
    fn the_blob_id_is_gits() {
        // `git hash-object` of "hello\n".
        assert_eq!(git_blob_id(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    #[test]
    fn the_next_page_comes_from_the_link_header() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::LINK,
            "<https://huggingface.co/api/models/a/b/tree/c?cursor=x>; rel=\"next\"".parse().unwrap(),
        );
        assert_eq!(next_page(&headers).as_deref(), Some("https://huggingface.co/api/models/a/b/tree/c?cursor=x"));
        assert_eq!(next_page(&reqwest::header::HeaderMap::new()), None);
    }

    /// Resolves every built-in entry against Hugging Face: each repository
    /// and file still exists and has a SHA-256 or a matching blob id.
    #[tokio::test]
    #[ignore = "Asks Hugging Face about 18 models and fetches two small files"]
    async fn every_built_in_entry_resolves_on_hugging_face() {
        let client = client();
        for entry in &crate::model_catalog::built_in().entries {
            let resolved = resolve(&client, HUB, entry).await.unwrap_or_else(|error| panic!("{}: {error}", entry.id));
            assert_eq!(resolved.files.len(), entry.files.len(), "{}", entry.id);
        }
    }
}
