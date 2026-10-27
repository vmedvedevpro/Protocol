//! The catalog on this repository's `main` branch, and the copy kept of it.
//!
//! Fallback order: the file on `main` → the last copy fetched from it → the
//! catalog built into the app. A fetched document replaces the one in use only
//! when it can be read and offers at least one model; anything else (GitHub
//! unreachable, an HTML error page, a schema for a newer app) leaves the
//! catalog in use and the cache as they are.

use super::schema::{self, Catalog, DocumentError};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const CATALOG_URL: &str = "https://raw.githubusercontent.com/vmedvedevpro/Protocol/main/model-catalog/catalog.json";

/// The catalog is a few kilobytes; anything far larger is not it.
const MAX_BYTES: usize = 1 << 20;

/// Where the catalog in use came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    Remote,
    Cache,
    BuiltIn,
}

pub fn cache_file(dir: &Path) -> PathBuf {
    dir.join("catalog.json")
}

/// Why no model list came from `main`.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchError {
    pub message: String,
    /// GitHub could not be asked now (no connection, a server error, a rate
    /// limit): the check did not complete and is tried again with backoff.
    /// Any other failure (a 404, an oversized or unreadable document) is
    /// GitHub's answer until `main` changes.
    pub transient: bool,
}

impl FetchError {
    fn transient(message: String) -> Self {
        Self { message, transient: true }
    }

    pub fn answered(message: String) -> Self {
        Self { message, transient: false }
    }
}

/// Downloads the catalog document, at most [`MAX_BYTES`].
pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, FetchError> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| FetchError::transient(format!("Couldn't reach GitHub for the model list: {error}")))?;
    let status = response.status();
    if !status.is_success() {
        let message = format!("GitHub answered {status} for the model list");
        let busy = status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS;
        return Err(if busy { FetchError::transient(message) } else { FetchError::answered(message) });
    }
    let too_large = || FetchError::answered("The model list on GitHub is too large to be one".to_string());
    if response.content_length().is_some_and(|length| length > MAX_BYTES as u64) {
        return Err(too_large());
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| FetchError::transient(format!("Couldn't read the model list from GitHub: {error}")))?;
        if body.len() + chunk.len() > MAX_BYTES {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Reads a document to use: readable, and with at least one usable model.
pub fn usable(bytes: &[u8]) -> Result<Catalog, DocumentError> {
    let catalog = schema::parse(bytes)?;
    if catalog.entries.is_empty() {
        return Err(DocumentError::NoModels);
    }
    Ok(catalog)
}

/// The catalog to start with: the cached copy, else the built-in one.
pub fn startup(dir: &Path, built_in: Arc<Catalog>) -> (Arc<Catalog>, Source) {
    let path = cache_file(dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return (built_in, Source::BuiltIn);
    };
    match usable(&bytes) {
        Ok(catalog) => (Arc::new(catalog), Source::Cache),
        Err(error) => {
            log::warn!("[model catalog] ignoring the cached model list {}: {error}", path.display());
            (built_in, Source::BuiltIn)
        }
    }
}

/// Keeps a fetched document for the next start.
pub fn write_cache(dir: &Path, bytes: &[u8]) -> std::io::Result<()> {
    super::write_atomically(&cache_file(dir), bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::built_in;

    fn document(models: serde_json::Value) -> Vec<u8> {
        serde_json::json!({ "schema": 1, "models": models }).to_string().into_bytes()
    }

    #[test]
    fn startup_prefers_a_readable_cache_and_falls_back_to_the_built_in_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let (catalog, source) = startup(dir.path(), built_in());
        assert_eq!(source, Source::BuiltIn);
        assert_eq!(catalog.entries.len(), built_in().entries.len());

        let one = serde_json::to_value(&built_in().entries[0]).unwrap();
        write_cache(dir.path(), &document(serde_json::json!([one]))).unwrap();
        let (catalog, source) = startup(dir.path(), built_in());
        assert_eq!((source, catalog.entries.len()), (Source::Cache, 1));

        // A cache another app version wrote, or a damaged one, is ignored.
        write_cache(dir.path(), br#"{"schema": 2, "models": []}"#).unwrap();
        assert_eq!(startup(dir.path(), built_in()).1, Source::BuiltIn);
        write_cache(dir.path(), b"{ trunc").unwrap();
        assert_eq!(startup(dir.path(), built_in()).1, Source::BuiltIn);
    }

    #[test]
    fn a_document_without_one_usable_model_is_not_used() {
        assert!(matches!(usable(&document(serde_json::json!([]))), Err(DocumentError::NoModels)));
        assert!(matches!(usable(&document(serde_json::json!([{ "id": "x" }]))), Err(DocumentError::NoModels)));
        assert!(matches!(usable(b"<!DOCTYPE html>"), Err(DocumentError::NotJson(_))));
    }

    #[tokio::test]
    async fn fetch_reports_errors_and_refuses_oversized_answers() {
        let url = crate::model_integrity::testing::serve_once(vec![b' '; MAX_BYTES + 1]).await;
        let client = crate::model_catalog::huggingface::client();
        let error = fetch(&client, &url).await.unwrap_err();
        assert!(error.message.contains("too large") && !error.transient, "{error:?}");
        let url = crate::model_integrity::testing::serve_once(b"{}".to_vec()).await;
        assert_eq!(fetch(&client, &url).await.unwrap(), b"{}");
        let error = fetch(&client, "http://127.0.0.1:9/catalog.json").await.unwrap_err();
        assert!(error.message.starts_with("Couldn't reach GitHub") && error.transient, "{error:?}");
        // A missing file is an answer; a failing server is not.
        let mut hub = crate::model_catalog::testing::Hub::new();
        hub.status("/gone.json", 404);
        hub.status("/busy.json", 503);
        let hub = hub.serve().await;
        let gone = fetch(&client, &format!("{}/gone.json", hub.url)).await.unwrap_err();
        assert_eq!((gone.message.as_str(), gone.transient), ("GitHub answered 404 Not Found for the model list", false));
        assert!(fetch(&client, &format!("{}/busy.json", hub.url)).await.unwrap_err().transient);
    }
}
