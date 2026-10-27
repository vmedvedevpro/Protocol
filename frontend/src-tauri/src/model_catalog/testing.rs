//! Test helpers: swapping the catalog in use, building entries, and a local
//! stand-in for the Hugging Face API and file server.

use super::remote::Source;
use super::schema::{Catalog, CatalogFile, Engine, Entry, License, LlamaParams, Sampling, PARAKEET_FILES};
use super::{built_in, set_active};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Tests that swap the catalog in use hold this, so they do not see each
/// other's catalogs.
pub static ACTIVE_LOCK: Mutex<()> = Mutex::new(());

/// Uses `catalog` until the guard is dropped, then the built-in one again.
pub fn use_catalog(catalog: Catalog) -> impl Drop {
    struct Restore(#[allow(dead_code)] std::sync::MutexGuard<'static, ()>);
    impl Drop for Restore {
        fn drop(&mut self) {
            set_active(built_in(), Source::BuiltIn);
        }
    }
    let guard = ACTIVE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    set_active(Arc::new(catalog), Source::Remote);
    Restore(guard)
}

/// A valid entry of `engine` named `id` in `repo`, with the engine's files.
pub fn entry_for(engine: Engine, id: &str, repo: &str) -> Entry {
    let file = |name: &str| CatalogFile { name: name.to_string(), path: name.to_string() };
    let (format, files, params) = match engine {
        Engine::Whisper => ("ggml", vec![file(&format!("ggml-{id}.bin"))], None),
        Engine::Parakeet => ("onnx-tdt-int8", PARAKEET_FILES.iter().map(|name| file(name)).collect(), None),
        Engine::Llama => (
            "gguf",
            vec![file("model.gguf")],
            Some(LlamaParams {
                chat_format: "gemma3".to_string(),
                context_size: 4096,
                sampling: Sampling {
                    temperature: 1.0,
                    top_k: 64,
                    top_p: 0.95,
                    presence_penalty: 0.0,
                    frequency_penalty: 0.0,
                    repeat_penalty: 1.0,
                    penalty_last_n: 0,
                },
                stop_tokens: vec!["<end_of_turn>".to_string()],
            }),
        ),
    };
    let entry = Entry {
        id: id.to_string(),
        engine,
        format: format.to_string(),
        name: format!("Test {id}"),
        description: String::new(),
        languages: vec!["*".to_string()],
        accuracy: None,
        speed: None,
        tier: None,
        recommended: false,
        listed: true,
        rank: 0,
        min_ram_gb: None,
        size_mb: 1,
        license: License { name: "MIT".to_string(), url: "https://example.com/license".to_string() },
        repo: repo.to_string(),
        revision: None,
        files,
        min_app_version: None,
        params,
    };
    assert!(entry.problems().is_empty(), "{:?}", entry.problems());
    entry
}

#[derive(Clone)]
struct Route {
    status: u16,
    body: Vec<u8>,
}

/// A local server answering like Hugging Face for the repositories added to
/// it: `api/models/<repo>`, `api/models/<repo>/tree/<commit>` and
/// `<repo>/resolve/<commit>/<path>` (with `Range` support).
#[derive(Default)]
pub struct Hub {
    routes: HashMap<String, Route>,
    trees: HashMap<String, Vec<serde_json::Value>>,
}

pub struct RepoBuilder<'a> {
    hub: &'a mut Hub,
    repo: String,
    commit: String,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `repo` whose default branch is at `commit`.
    pub fn repo(&mut self, repo: &str, commit: &str) -> RepoBuilder<'_> {
        let info = serde_json::json!({ "id": repo, "sha": commit });
        self.routes.insert(format!("/api/models/{repo}"), Route { status: 200, body: info.to_string().into_bytes() });
        self.trees.entry(format!("/api/models/{repo}/tree/{commit}")).or_default();
        RepoBuilder { hub: self, repo: repo.to_string(), commit: commit.to_string() }
    }

    /// Answers `path` with an empty body and `status`.
    pub fn status(&mut self, path: &str, status: u16) {
        self.routes.insert(path.to_string(), Route { status, body: Vec::new() });
    }

    pub async fn serve(self) -> ServedHub {
        let mut routes = self.routes;
        for (path, items) in self.trees {
            routes.insert(path, Route { status: 200, body: serde_json::Value::from(items).to_string().into_bytes() });
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests: Arc<Mutex<Vec<String>>> = Arc::default();
        let routes = Arc::new(Mutex::new(routes));
        let served = ServedHub { url, requests: requests.clone() };
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { return };
                let routes = routes.clone();
                let requests = requests.clone();
                tokio::spawn(answer(stream, routes, requests));
            }
        });
        served
    }
}

impl RepoBuilder<'_> {
    fn add(&mut self, path: &str, item: serde_json::Value, served: &[u8]) -> &mut Self {
        let tree = format!("/api/models/{}/tree/{}", self.repo, self.commit);
        self.hub.trees.get_mut(&tree).unwrap().push(item);
        self.hub.routes.insert(
            format!("/{}/resolve/{}/{path}", self.repo, self.commit),
            Route { status: 200, body: served.to_vec() },
        );
        self
    }

    /// A file kept in Git LFS: the listing carries its SHA-256.
    pub fn lfs_file(&mut self, path: &str, content: &[u8]) -> &mut Self {
        self.lfs_file_serving(path, content, content)
    }

    /// An LFS file listed as `listed` but served as `served`.
    pub fn lfs_file_serving(&mut self, path: &str, listed: &[u8], served: &[u8]) -> &mut Self {
        let item = serde_json::json!({
            "type": "file",
            "oid": super::huggingface::git_blob_id(path.as_bytes()),
            "size": listed.len(),
            "path": path,
            "lfs": { "oid": format!("{:x}", Sha256::digest(listed)), "size": listed.len(), "pointerSize": 134 },
        });
        self.add(path, item, served)
    }

    /// A file kept in Git: the listing carries only its blob id.
    pub fn git_file(&mut self, path: &str, content: &[u8]) -> &mut Self {
        self.git_file_serving(path, content, content)
    }

    /// A Git file listed as `listed` but served as `served`.
    pub fn git_file_serving(&mut self, path: &str, listed: &[u8], served: &[u8]) -> &mut Self {
        let item = serde_json::json!({
            "type": "file",
            "oid": super::huggingface::git_blob_id(listed),
            "size": listed.len(),
            "path": path,
        });
        self.add(path, item, served)
    }
}

pub struct ServedHub {
    pub url: String,
    requests: Arc<Mutex<Vec<String>>>,
}

impl ServedHub {
    /// How many requests asked for `path`.
    pub fn requests(&self, path: &str) -> usize {
        self.requests.lock().unwrap().iter().filter(|request| request.as_str() == path).count()
    }
}

async fn answer(
    mut stream: tokio::net::TcpStream,
    routes: Arc<Mutex<HashMap<String, Route>>>,
    requests: Arc<Mutex<Vec<String>>>,
) {
    let mut request = Vec::new();
    let mut buffer = [0; 2048];
    while !request.windows(4).any(|part| part == b"\r\n\r\n") {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => request.extend_from_slice(&buffer[..read]),
        }
    }
    let text = String::from_utf8_lossy(&request).to_string();
    let path = text.split_whitespace().nth(1).unwrap_or("/").split('?').next().unwrap_or("/").to_string();
    requests.lock().unwrap().push(path.clone());
    let range_start = text
        .lines()
        .find_map(|line| line.to_ascii_lowercase().strip_prefix("range: bytes=").map(str::to_string))
        .and_then(|range| range.trim_end_matches('-').parse::<usize>().ok());
    let route = routes.lock().unwrap().get(&path).cloned();
    let (head, body) = match route {
        None => ("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n".to_string(), Vec::new()),
        Some(route) if route.status != 200 => (format!("HTTP/1.1 {} Status\r\nContent-Length: 0\r\n", route.status), Vec::new()),
        Some(route) => match range_start {
            Some(start) if start > 0 && start < route.body.len() => (
                format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{}\r\n",
                    route.body.len() - start,
                    route.body.len() - 1,
                    route.body.len()
                ),
                route.body[start..].to_vec(),
            ),
            _ => (format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n", route.body.len()), route.body),
        },
    };
    let _ = stream.write_all(format!("{head}Connection: close\r\n\r\n").as_bytes()).await;
    let _ = stream.write_all(&body).await;
}
