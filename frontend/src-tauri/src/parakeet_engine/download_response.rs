//! Strict, cancellable artifact requests. Recovery follows upstream #749 while
//! retaining this fork's pinned catalog (`crate::model_integrity`).
use anyhow::{anyhow, Result};
use reqwest::{Client, Response, StatusCode};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use super::parakeet_engine::DOWNLOAD_CANCELLED_MESSAGE;

pub(super) async fn artifact_response(
    client: &Client,
    url: &str,
    resume: u64,
    expected: u64,
    cancellation: &CancellationToken,
) -> Result<(Response, bool)> {
    async fn send(client: &Client, url: &str, resume: u64, cancellation: &CancellationToken) -> Result<Response> {
        let mut request = client.get(url);
        if resume > 0 { request = request.header("Range", format!("bytes={resume}-")); }
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => Err(anyhow!(DOWNLOAD_CANCELLED_MESSAGE)),
            result = tokio::time::timeout(Duration::from_secs(30), request.send()) => {
                result.map_err(|_| anyhow!("Timed out waiting for artifact headers"))?
                    .map_err(Into::into)
            }
        }
    }
    let mut response = send(client, url, resume, cancellation).await?;
    let mut requested_offset = resume;
    if response.status() == StatusCode::RANGE_NOT_SATISFIABLE && resume > 0 {
        // Retry only this artifact, once, without Range. Do not truncate a saved
        // partial until the replacement response has passed validation.
        drop(response);
        response = send(client, url, 0, cancellation).await?;
        requested_offset = 0;
    }
    let resumed = validate_response(&response, requested_offset, expected)?;
    Ok((response, resumed))
}

fn validate_response(response: &Response, offset: u64, expected: u64) -> Result<bool> {
    if expected == 0 || offset >= expected {
        return Err(anyhow!("Invalid artifact size or resume offset"));
    }
    match response.status() {
        StatusCode::PARTIAL_CONTENT => {
            let range = response.headers().get(reqwest::header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok()).unwrap_or_default();
            let exact = format!("bytes {offset}-{}/{}", expected - 1, expected);
            if range != exact || response.content_length() != Some(expected - offset) {
                return Err(anyhow!("Unexpected artifact resume range: {range}"));
            }
            Ok(offset > 0)
        }
        StatusCode::OK if response.content_length() == Some(expected) => Ok(false),
        StatusCode::OK => Err(anyhow!("Unexpected artifact length: {:?}; expected {expected}", response.content_length())),
        status => Err(anyhow!("Artifact request returned {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn server(replies: Vec<(&'static str, bool)>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/artifact", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            for (reply, range) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    assert!(read > 0);
                    request.extend_from_slice(&buffer[..read]);
                }
                assert_eq!(String::from_utf8_lossy(&request).to_lowercase().contains("range: bytes=2-"), range);
                stream.write_all(reply.as_bytes()).await.unwrap();
            }
        });
        (url, task)
    }

    #[tokio::test]
    async fn rejected_range_retries_without_range_but_not_forever() {
        let (url, task) = server(vec![
            ("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", true),
            ("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nfull", false),
        ]).await;
        let client = Client::builder().no_proxy().build().unwrap();
        let (response, resumed) = artifact_response(&client, &url, 2, 4, &CancellationToken::new()).await.unwrap();
        assert!(!resumed);
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"full");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn resume_and_ignored_range_have_distinct_write_modes() {
        for (reply, should_resume) in [
            ("HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 2-3/4\r\nConnection: close\r\n\r\ncd", true),
            ("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd", false),
        ] {
            let (url, task) = server(vec![(reply, true)]).await;
            let (_, resumed) = artifact_response(&Client::builder().no_proxy().build().unwrap(), &url, 2, 4, &CancellationToken::new()).await.unwrap();
            assert_eq!(resumed, should_resume);
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn malformed_ranges_and_http_errors_are_not_accepted() {
        for reply in [
            "HTTP/1.1 206 Partial Content\r\nContent-Length: 2\r\nContent-Range: bytes 2-99/4\r\nConnection: close\r\n\r\ncd",
            "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad",
        ] {
            let (url, task) = server(vec![(reply, true)]).await;
            assert!(artifact_response(&Client::builder().no_proxy().build().unwrap(), &url, 2, 4, &CancellationToken::new()).await.is_err());
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_a_stalled_header_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/artifact", listener.local_addr().unwrap());
        let token = CancellationToken::new();
        let cancel = token.clone();
        let task = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.unwrap();
            cancel.cancel();
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        let result = tokio::time::timeout(Duration::from_secs(1), artifact_response(&Client::builder().no_proxy().build().unwrap(), &url, 0, 4, &token)).await.unwrap();
        assert_eq!(result.unwrap_err().to_string(), DOWNLOAD_CANCELLED_MESSAGE);
        task.await.unwrap();
    }
}
