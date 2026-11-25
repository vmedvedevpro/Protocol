//! Plays recordings in WebKitGTK, whose media player refuses Tauri's asset
//! protocol: `MediaPlayerPrivateGStreamer::load` lets only blob, data, file,
//! http and https URLs reach GStreamer (`isProtocolAllowed` in
//! WebKit's GStreamerCommon.cpp) and fails any other scheme with a
//! FormatError before a byte is requested. A blob or data URL would hold the
//! whole file in memory, and a file URL is not displayable from the
//! `tauri://` page, so on Linux native serves each recording over loopback
//! HTTP instead, with byte ranges, so a two-hour recording seeks without
//! being read whole.
//!
//! The server is not open to whoever finds the port. It binds 127.0.0.1 only
//! and serves only files native registered through `stream_url`, each under
//! a random 256-bit token: a request never names a path, and another local
//! user or a web page in a browser cannot guess one. Tokens live until the
//! app quits; there is one per recording a meeting screen opened. Whoever
//! connects without a token can still hold connections open, so at most
//! `MAX_CONNECTIONS` are served at once (the rest wait in the kernel's listen
//! backlog, holding no descriptor of the app's) and each must send its
//! request head within `HEAD_TIMEOUT`.

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

/// A request head larger than this is not a media request.
const MAX_HEAD: usize = 8 * 1024;
/// A client that does not finish its request head in this time is dropped.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections served at once. The WebView needs a few per player (a range
/// request per seek); the cap keeps a local process or a scanning page from
/// using up the app's file descriptors, which the recorder and the database
/// need too.
const MAX_CONNECTIONS: usize = 32;
/// After a failed accept (out of descriptors, say), wait before the next one
/// instead of failing again in a hot loop.
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

struct Server {
    port: u16,
    /// token -> recording
    files: Mutex<HashMap<String, PathBuf>>,
}

impl Server {
    /// Binds a server of its own; the app keeps one (`server`), tests start theirs.
    fn start(max_connections: usize) -> io::Result<&'static Server> {
        let listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        // Lives as long as its accept loop, which is the app's run.
        let server: &'static Server = Box::leak(Box::new(Server { port, files: Mutex::new(HashMap::new()) }));
        tauri::async_runtime::spawn(accept(listener, server, Arc::new(Semaphore::new(max_connections))));
        Ok(server)
    }

    fn url_for(&self, path: &Path) -> String {
        let mut files = self.files.lock().unwrap_or_else(|e| e.into_inner());
        let token = match files.iter().find(|(_, file)| file.as_path() == path) {
            Some((token, _)) => token.clone(),
            None => {
                let token: String = rand::random::<[u8; 32]>().iter().map(|byte| format!("{:02x}", byte)).collect();
                files.insert(token.clone(), path.to_path_buf());
                token
            }
        };
        format!("http://127.0.0.1:{}/{}", self.port, token)
    }

    fn file(&self, token: &str) -> Option<PathBuf> {
        self.files.lock().unwrap_or_else(|e| e.into_inner()).get(token).cloned()
    }
}

/// Only a started server is kept: a failed bind is tried again on the next call.
static SERVER: OnceLock<&'static Server> = OnceLock::new();
static STARTING: Mutex<()> = Mutex::new(());

fn server() -> Result<&'static Server, String> {
    if let Some(server) = SERVER.get() {
        return Ok(server);
    }
    let _starting = STARTING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(server) = SERVER.get() {
        return Ok(server);
    }
    let server = Server::start(MAX_CONNECTIONS).map_err(|e| format!("Failed to start the recording stream: {}", e))?;
    Ok(SERVER.get_or_init(|| server))
}

/// The loopback URL the WebView plays `path` from. The same file keeps its token.
pub fn stream_url(path: &Path) -> Result<String, String> {
    Ok(server()?.url_for(path))
}

async fn accept(listener: std::net::TcpListener, server: &'static Server, permits: Arc<Semaphore>) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("Recording stream stopped: {}", e);
            return;
        }
    };
    loop {
        // Taken before accepting, so a connection past the cap stays in the
        // backlog instead of costing a descriptor; it goes with the task.
        let Ok(permit) = permits.clone().acquire_owned().await else { return };
        match listener.accept().await {
            Ok((socket, _)) => {
                tauri::async_runtime::spawn(async move {
                    let _permit = permit;
                    if let Err(e) = respond(socket, server).await {
                        log::debug!("Recording stream request ended: {}", e);
                    }
                });
            }
            Err(e) => {
                log::warn!("Recording stream accept failed: {}", e);
                tokio::time::sleep(ACCEPT_BACKOFF).await;
            }
        }
    }
}

#[derive(Debug, PartialEq)]
struct Request<'a> {
    head_only: bool,
    token: &'a str,
    range: Option<&'a str>,
}

/// GET or HEAD `/<token>` with an optional Range header; anything else is refused.
fn parse_request(head: &str) -> Option<Request<'_>> {
    let mut lines = head.split("\r\n");
    let mut start = lines.next()?.split(' ');
    let head_only = match start.next()? {
        "GET" => false,
        "HEAD" => true,
        _ => return None,
    };
    let token = start.next()?.strip_prefix('/')?;
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim().eq_ignore_ascii_case("range").then(|| value.trim())
    });
    Some(Request { head_only, token, range })
}

/// The inclusive byte span a Range header asks of a file of `len` bytes.
/// `Ok(None)` serves the whole file: no header, or one to ignore as RFC 9110
/// allows (not one `bytes=` range, or not valid syntax). `Err` is a valid
/// range that lies past the end, answered with 416.
fn byte_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|value| value.strip_prefix("bytes=")) else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((first, last)) = spec.trim().split_once('-') else { return Ok(None) };
    let span = match (first.trim(), last.trim()) {
        ("", "") => return Ok(None),
        ("", suffix) => {
            let Ok(suffix) = suffix.parse::<u64>() else { return Ok(None) };
            if suffix == 0 || len == 0 {
                return Err(());
            }
            (len.saturating_sub(suffix), len - 1)
        }
        (first, last) => {
            let Ok(first) = first.parse::<u64>() else { return Ok(None) };
            let last = if last.is_empty() {
                u64::MAX
            } else {
                match last.parse::<u64>() {
                    Ok(last) if last >= first => last,
                    _ => return Ok(None),
                }
            };
            if first >= len {
                return Err(());
            }
            (first, last.min(len - 1))
        }
    };
    Ok(Some(span))
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp4" | "m4a" | "aac") => "audio/mp4",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("ogg") => "audio/ogg",
        Some("webm") => "audio/webm",
        _ => "application/octet-stream",
    }
}

async fn read_head(socket: &mut TcpStream) -> io::Result<String> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        if head.len() > MAX_HEAD {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "request head too large"));
        }
        let read = socket.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        head.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8(head).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "request head is not UTF-8"))
}

async fn reply(socket: &mut TcpStream, status: &str, headers: &str) -> io::Result<()> {
    let head = format!("HTTP/1.1 {}\r\nConnection: close\r\nCache-Control: no-store\r\n{}\r\n", status, headers);
    socket.write_all(head.as_bytes()).await
}

async fn respond(mut socket: TcpStream, server: &Server) -> io::Result<()> {
    let head = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut socket))
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    let Some(request) = parse_request(&head) else {
        return reply(&mut socket, "400 Bad Request", "Content-Length: 0\r\n").await;
    };
    let Some(path) = server.file(request.token) else {
        return reply(&mut socket, "404 Not Found", "Content-Length: 0\r\n").await;
    };
    let mut file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => return reply(&mut socket, "404 Not Found", "Content-Length: 0\r\n").await,
    };
    let len = file.metadata().await?.len();
    let kind = content_type(&path);
    let (status, first, count, span) = match byte_range(request.range, len) {
        Ok(Some((first, last))) => (
            "206 Partial Content",
            first,
            last - first + 1,
            format!("Content-Range: bytes {}-{}/{}\r\n", first, last, len),
        ),
        Ok(None) => ("200 OK", 0, len, String::new()),
        Err(()) => {
            let headers = format!("Content-Range: bytes */{}\r\nContent-Length: 0\r\n", len);
            return reply(&mut socket, "416 Range Not Satisfiable", &headers).await;
        }
    };
    let headers = format!("Content-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\n{}", kind, count, span);
    reply(&mut socket, status, &headers).await?;
    if request.head_only {
        return Ok(());
    }
    // Streamed through tokio's fixed copy buffer: memory stays flat however
    // long the recording is.
    file.seek(io::SeekFrom::Start(first)).await?;
    tokio::io::copy(&mut file.take(count), &mut socket).await?;
    socket.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parses_the_request_line_and_range() {
        assert_eq!(
            parse_request("GET /abc HTTP/1.1\r\nHost: 127.0.0.1\r\nrange: bytes=10-\r\n\r\n"),
            Some(Request { head_only: false, token: "abc", range: Some("bytes=10-") })
        );
        assert_eq!(parse_request("HEAD /abc HTTP/1.1\r\n\r\n").map(|r| r.head_only), Some(true));
        assert_eq!(parse_request("POST /abc HTTP/1.1\r\n\r\n"), None);
        assert_eq!(parse_request("GET abc HTTP/1.1\r\n\r\n"), None);
    }

    #[test]
    fn reads_byte_ranges() {
        assert_eq!(byte_range(None, 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=0-"), 100), Ok(Some((0, 99))));
        assert_eq!(byte_range(Some("bytes=10-19"), 100), Ok(Some((10, 19))));
        assert_eq!(byte_range(Some("bytes=90-200"), 100), Ok(Some((90, 99))));
        assert_eq!(byte_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(byte_range(Some("bytes=-500"), 100), Ok(Some((0, 99))));
        assert_eq!(byte_range(Some("bytes=0-1,5-6"), 100), Ok(None));
        // A valid range past the end is unsatisfiable...
        assert_eq!(byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=-0"), 100), Err(()));
        // ...while one that is not valid syntax is ignored.
        assert_eq!(byte_range(Some("bytes=x-"), 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=-y"), 100), Ok(None));
        assert_eq!(byte_range(Some("bytes=20-10"), 100), Ok(None));
        assert_eq!(byte_range(Some("items=0-1"), 100), Ok(None));
    }

    /// Sends `request` raw and returns the response head and body.
    fn send(port: u16, request: &[u8]) -> (String, Vec<u8>) {
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        socket.write_all(request).unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).unwrap();
        let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8(response[..split].to_vec()).unwrap(), response[split + 4..].to_vec())
    }

    fn get(url: &str, extra: &str) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let port = host.rsplit(':').next().unwrap().parse().unwrap();
        send(port, format!("GET /{} HTTP/1.1\r\nHost: {}\r\n{}\r\n", path, host, extra).as_bytes())
    }

    fn recording(bytes: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        std::fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn serves_a_registered_file_in_ranges_and_nothing_else() {
        let bytes: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let (_dir, path) = recording(&bytes);
        let url = stream_url(&path).unwrap();
        assert_eq!(stream_url(&path).unwrap(), url, "one token per file");

        let (head, body) = get(&url, "");
        assert!(head.starts_with("HTTP/1.1 200"), "{}", head);
        assert!(head.contains("Content-Type: audio/wav"));
        assert_eq!(body, bytes);

        let (head, body) = get(&url, "Range: bytes=5000-5009\r\n");
        assert!(head.starts_with("HTTP/1.1 206"), "{}", head);
        assert!(head.contains("Content-Range: bytes 5000-5009/10000"));
        assert_eq!(body, &bytes[5000..5010]);

        let (head, _) = get(&url, "Range: bytes=20000-\r\n");
        assert!(head.starts_with("HTTP/1.1 416"), "{}", head);
        let (head, body) = get(&url, "Range: bytes=x-\r\n");
        assert!(head.starts_with("HTTP/1.1 200"), "an invalid range is ignored: {}", head);
        assert_eq!(body, bytes);

        let port_and_slash = &url[..url.rfind('/').unwrap() + 1];
        let (head, _) = get(&format!("{}{}", port_and_slash, "0".repeat(64)), "");
        assert!(head.starts_with("HTTP/1.1 404"), "an unknown token: {}", head);
        let (head, _) = get(&format!("{}{}", port_and_slash, path.display()), "");
        assert!(head.starts_with("HTTP/1.1 404"), "a path is not a token: {}", head);
    }

    #[test]
    fn refuses_other_methods_and_answers_head_without_a_body() {
        let (_dir, path) = recording(&[7u8; 1000]);
        let url = stream_url(&path).unwrap();
        let port = server().unwrap().port;
        let token = &url[url.rfind('/').unwrap() + 1..];

        let (head, body) = send(port, format!("POST /{} HTTP/1.1\r\n\r\n", token).as_bytes());
        assert!(head.starts_with("HTTP/1.1 400"), "{}", head);
        assert!(body.is_empty());

        let (head, body) = send(port, format!("HEAD /{} HTTP/1.1\r\nRange: bytes=0-9\r\n\r\n", token).as_bytes());
        assert!(head.starts_with("HTTP/1.1 206"), "{}", head);
        assert!(head.contains("Content-Length: 10"));
        assert!(body.is_empty(), "HEAD sends no body");
    }

    #[test]
    fn closes_a_connection_whose_head_is_too_large() {
        let port = server().unwrap().port;
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut request = b"GET /x HTTP/1.1\r\nX-Padding: ".to_vec();
        request.extend(std::iter::repeat(b'a').take(4 * MAX_HEAD));
        // The server may close before it has read everything: a reset is a close too.
        let _ = socket.write_all(&request);
        let mut response = Vec::new();
        match socket.read_to_end(&mut response) {
            Ok(_) => assert!(response.is_empty(), "no response to an oversized head"),
            Err(e) => assert_eq!(e.kind(), io::ErrorKind::ConnectionReset, "{e}"),
        }
    }

    #[test]
    fn serves_no_more_than_its_connection_cap_at_once() {
        let server = Server::start(2).unwrap();
        let (_dir, path) = recording(b"0123456789");
        let url = server.url_for(&path);
        let token = &url[url.rfind('/').unwrap() + 1..];

        // Two clients that connect and send nothing hold both permits.
        let idle: Vec<_> = (0..2).map(|_| std::net::TcpStream::connect(("127.0.0.1", server.port)).unwrap()).collect();
        std::thread::sleep(Duration::from_millis(200));

        let mut third = std::net::TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        third.write_all(format!("GET /{} HTTP/1.1\r\n\r\n", token).as_bytes()).unwrap();
        third.set_read_timeout(Some(Duration::from_millis(500))).unwrap();
        let mut response = Vec::new();
        let waited = third.read_to_end(&mut response);
        assert!(waited.is_err() && response.is_empty(), "the third waits while two are held");

        // Once they go, it is served.
        drop(idle);
        third.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        third.read_to_end(&mut response).unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&response));
    }
}
