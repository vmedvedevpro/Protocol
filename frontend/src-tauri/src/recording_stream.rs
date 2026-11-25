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
//! app quits; there is one per recording a meeting screen opened.

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// A request head larger than this is not a media request.
const MAX_HEAD: usize = 8 * 1024;
/// A client that does not finish its request head in this time is dropped.
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

struct Server {
    port: u16,
    /// token -> recording
    files: Mutex<HashMap<String, PathBuf>>,
}

static SERVER: OnceLock<Result<Server, String>> = OnceLock::new();

fn server() -> Result<&'static Server, String> {
    SERVER
        .get_or_init(|| {
            let listener = std::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
                .and_then(|listener| listener.set_nonblocking(true).map(|()| listener))
                .map_err(|e| format!("Failed to start the recording stream: {}", e))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("Failed to start the recording stream: {}", e))?
                .port();
            tauri::async_runtime::spawn(accept(listener));
            Ok(Server { port, files: Mutex::new(HashMap::new()) })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// The loopback URL the WebView plays `path` from. The same file keeps its token.
pub fn stream_url(path: &Path) -> Result<String, String> {
    let server = server()?;
    let mut files = server.files.lock().unwrap_or_else(|e| e.into_inner());
    let token = match files.iter().find(|(_, file)| file.as_path() == path) {
        Some((token, _)) => token.clone(),
        None => {
            let token: String = rand::random::<[u8; 32]>().iter().map(|byte| format!("{:02x}", byte)).collect();
            files.insert(token.clone(), path.to_path_buf());
            token
        }
    };
    Ok(format!("http://127.0.0.1:{}/{}", server.port, token))
}

async fn accept(listener: std::net::TcpListener) {
    let listener = match tokio::net::TcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(e) => {
            log::error!("Recording stream stopped: {}", e);
            return;
        }
    };
    loop {
        match listener.accept().await {
            Ok((socket, _)) => {
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = respond(socket).await {
                        log::debug!("Recording stream request ended: {}", e);
                    }
                });
            }
            Err(e) => log::warn!("Recording stream accept failed: {}", e),
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

/// The inclusive byte span a Range header asks of a file of `len` bytes:
/// `Ok(None)` for the whole file (no header, or one this server does not
/// split, such as several ranges), `Err` when it lies past the end.
fn byte_range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|value| value.strip_prefix("bytes=")) else { return Ok(None) };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((first, last)) = spec.trim().split_once('-') else { return Ok(None) };
    let span = match (first.trim(), last.trim()) {
        ("", "") => return Ok(None),
        ("", suffix) => {
            let suffix: u64 = suffix.parse().map_err(|_| ())?;
            if suffix == 0 || len == 0 {
                return Err(());
            }
            (len.saturating_sub(suffix), len - 1)
        }
        (first, last) => {
            let first: u64 = first.parse().map_err(|_| ())?;
            let last = if last.is_empty() { u64::MAX } else { last.parse().map_err(|_| ())? };
            if first >= len || last < first {
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

async fn respond(mut socket: TcpStream) -> io::Result<()> {
    let head = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut socket))
        .await
        .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))??;
    let Some(request) = parse_request(&head) else {
        return reply(&mut socket, "400 Bad Request", "Content-Length: 0\r\n").await;
    };
    let path = server()
        .ok()
        .and_then(|server| server.files.lock().unwrap_or_else(|e| e.into_inner()).get(request.token).cloned());
    let Some(path) = path else {
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
        assert_eq!(byte_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=20-10"), 100), Err(()));
        assert_eq!(byte_range(Some("bytes=x-"), 100), Err(()));
    }

    fn get(url: &str, extra: &str) -> (String, Vec<u8>) {
        let rest = url.strip_prefix("http://").unwrap();
        let (host, path) = rest.split_once('/').unwrap();
        let mut socket = std::net::TcpStream::connect(host).unwrap();
        write!(socket, "GET /{} HTTP/1.1\r\nHost: {}\r\n{}\r\n", path, host, extra).unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).unwrap();
        let split = response.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        (String::from_utf8(response[..split].to_vec()).unwrap(), response[split + 4..].to_vec())
    }

    #[test]
    fn serves_a_registered_file_in_ranges_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audio.wav");
        let bytes: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        std::fs::write(&path, &bytes).unwrap();
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

        let port_and_slash = &url[..url.rfind('/').unwrap() + 1];
        let (head, _) = get(&format!("{}{}", port_and_slash, "0".repeat(64)), "");
        assert!(head.starts_with("HTTP/1.1 404"), "an unknown token: {}", head);
        let (head, _) = get(&format!("{}{}", port_and_slash, path.display()), "");
        assert!(head.starts_with("HTTP/1.1 404"), "a path is not a token: {}", head);
    }
}
