//! What Claude, OpenAI and Groq answer when Settings › Summary model or first
//! launch asks for their models with the user's key (#189 in #220).
//!
//! The list is only what the provider returns for that key: there is no
//! built-in list to fall back on and no cache here. A failure comes back as a
//! [`ModelListError`] the UI words by cause (`src/api/summaryProviders.ts`),
//! so a rejected key shows next to the key field instead of surfacing later
//! as a failed summary. The UI keeps each key's list in its own query, so a
//! list fetched with one key is never shown for another.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::fmt;
use std::time::Duration;

/// One request's limit. The user waits on an open settings page with a
/// spinner; this gives a slow connection time to answer and still ends the
/// wait with "could not be reached" rather than a spinner that never stops.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a provider's models could not be listed. Serialized with a `kind` tag,
/// which the UI branches on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelListError {
    /// No key was given; nothing was asked.
    MissingKey,
    /// The key has characters no key has (a line break, a space, a letter
    /// outside ASCII), so it cannot go in a header; nothing was asked.
    InvalidKey,
    /// The provider did not accept the key (401 or 403).
    KeyRejected { status: u16 },
    /// No answer: no connection, DNS, TLS, or the request timed out.
    Unreachable { reason: String },
    /// The provider answered with another unsuccessful status.
    Status { status: u16, reason: Option<String> },
    /// The answer was not the list the provider documents.
    InvalidResponse { reason: String },
    /// The HTTP client could not be set up here; nothing was asked.
    ClientUnavailable { reason: String },
}

impl fmt::Display for ModelListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingKey => write!(f, "no API key"),
            Self::InvalidKey => write!(f, "the key has characters a key cannot have"),
            Self::KeyRejected { status } => write!(f, "the key was not accepted (status {status})"),
            Self::Unreachable { reason } => write!(f, "the provider could not be reached: {reason}"),
            Self::Status { status, reason } => match reason {
                Some(reason) => write!(f, "the provider answered with status {status} {reason}"),
                None => write!(f, "the provider answered with status {status}"),
            },
            Self::InvalidResponse { reason } => write!(f, "the provider's answer could not be read: {reason}"),
            Self::ClientUnavailable { reason } => write!(f, "the request could not be prepared: {reason}"),
        }
    }
}

/// The trimmed key; `MissingKey` for none or a blank one, and `InvalidKey`
/// for one with a character outside printable ASCII, which every provider's
/// keys are made of. Such a key (a pasted line break, a space, a lookalike
/// letter) cannot go in a header: reqwest would fail while building the
/// request, which must not read as "could not be reached".
pub(crate) fn require_key(api_key: Option<String>) -> Result<String, ModelListError> {
    let key = api_key.as_deref().map(str::trim).unwrap_or_default();
    if key.is_empty() {
        return Err(ModelListError::MissingKey);
    }
    if !key.chars().all(|c| c.is_ascii_graphic()) {
        return Err(ModelListError::InvalidKey);
    }
    Ok(key.to_string())
}

/// A client with the request limit; each listing builds its own, as before.
/// A client that cannot be built is an error, not a client without the limit.
pub(crate) fn client() -> Result<reqwest::Client, ModelListError> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| ModelListError::ClientUnavailable { reason: error.to_string() })
}

/// Sends `request` and reads its JSON body, mapping each failure to its cause.
pub(crate) async fn fetch_json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, ModelListError> {
    let response = request.send().await.map_err(send_error)?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(ModelListError::KeyRejected { status: status.as_u16() });
    }
    if !status.is_success() {
        return Err(ModelListError::Status {
            status: status.as_u16(),
            reason: status.canonical_reason().map(str::to_string),
        });
    }
    let body = response.bytes().await.map_err(|error| ModelListError::Unreachable { reason: transport_reason(error) })?;
    serde_json::from_slice(&body).map_err(|error| ModelListError::InvalidResponse { reason: error.to_string() })
}

/// Why sending failed. A request that could not be built never left: the
/// URLs are constants, so the header with the key is what reqwest refused
/// (`require_key` stops the keys it knows of first).
fn send_error(error: reqwest::Error) -> ModelListError {
    if error.is_builder() {
        return ModelListError::InvalidKey;
    }
    ModelListError::Unreachable { reason: transport_reason(error) }
}

/// A transport failure in a few words, without the URL reqwest appends.
fn transport_reason(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return format!("no answer within {} s", REQUEST_TIMEOUT.as_secs());
    }
    if error.is_connect() {
        return "no connection".to_string();
    }
    error.without_url().to_string()
}

/// Logs the outcome of one provider's listing; the key is never logged.
pub(crate) fn log_outcome<T>(provider: &str, result: &Result<Vec<T>, ModelListError>) {
    match result {
        Ok(models) => log::info!("{provider} listed {} models", models.len()),
        Err(error) => log::warn!("Could not list {provider} models: {error}"),
    }
}

/// A one-connection-per-response HTTP server on localhost for the providers'
/// tests: each accepted connection reads one request and answers with the
/// next canned response, and the requests' heads (request line and headers)
/// are kept so a test can check the paging parameters and the key's header.
#[cfg(test)]
pub(crate) mod test_server {
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub struct Canned {
        pub status: u16,
        pub body: String,
    }

    pub struct TestServer {
        pub base: String,
        pub requests: Arc<Mutex<Vec<String>>>,
    }

    pub async fn serve(responses: Vec<Canned>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind a local port");
        let base = format!("http://{}", listener.local_addr().expect("local address"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        tokio::spawn(async move {
            for canned in responses {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                // The tests' requests are GETs without a body, so the head is all there is.
                let mut head = Vec::new();
                let mut buffer = [0u8; 4096];
                while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => head.extend_from_slice(&buffer[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&head).to_string();
                seen.lock().unwrap().push(text);
                let response = format!(
                    "HTTP/1.1 {} Test\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                    canned.status,
                    canned.body.len(),
                    canned.body
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        TestServer { base, requests }
    }

    pub fn json(status: u16, body: &str) -> Canned {
        Canned { status, body: body.to_string() }
    }
}

#[cfg(test)]
mod tests {
    use super::test_server::{json, serve};
    use super::*;

    #[derive(serde::Deserialize, Debug)]
    struct Body {
        data: Vec<serde_json::Value>,
    }

    async fn fetch(status: u16, body: &str) -> Result<Body, ModelListError> {
        let server = serve(vec![json(status, body)]).await;
        fetch_json(client().unwrap().get(format!("{}/v1/models", server.base))).await
    }

    #[tokio::test]
    async fn rejected_keys_are_named_as_such() {
        for status in [401, 403] {
            assert_eq!(fetch(status, r#"{"error":{}}"#).await.unwrap_err(), ModelListError::KeyRejected { status });
        }
    }

    #[tokio::test]
    async fn another_status_keeps_its_code() {
        assert_eq!(
            fetch(529, "{}").await.unwrap_err(),
            ModelListError::Status { status: 529, reason: None },
        );
        assert_eq!(
            fetch(500, "{}").await.unwrap_err(),
            ModelListError::Status { status: 500, reason: Some("Internal Server Error".to_string()) },
        );
    }

    #[tokio::test]
    async fn an_unreadable_answer_is_not_an_empty_list() {
        assert!(matches!(fetch(200, "<html>").await.unwrap_err(), ModelListError::InvalidResponse { .. }));
    }

    #[tokio::test]
    async fn a_closed_port_is_unreachable() {
        // Bind and drop: the port is free and nothing listens on it.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let error = fetch_json::<Body>(client().unwrap().get(format!("http://127.0.0.1:{port}/v1/models"))).await.unwrap_err();
        assert_eq!(error, ModelListError::Unreachable { reason: "no connection".to_string() });
    }

    #[tokio::test]
    async fn a_listing_is_read() {
        assert_eq!(fetch(200, r#"{"data":[{"id":"a"}]}"#).await.unwrap().data.len(), 1);
    }

    #[test]
    fn a_key_with_characters_no_key_has_asks_nothing() {
        for key in ["sk-ant-abc\ndef", "sk ant", "sk-ant-ключ", "sk-ant-\u{200b}x"] {
            assert_eq!(require_key(Some(key.into())), Err(ModelListError::InvalidKey), "{key:?}");
        }
        // Surrounding white space, a trailing line break included, is trimmed.
        assert_eq!(require_key(Some("sk-ant-abc\n".into())), Ok("sk-ant-abc".to_string()));
    }

    #[tokio::test]
    async fn a_header_reqwest_refuses_is_an_invalid_key() {
        // What `require_key` guards against, sent anyway: reqwest refuses to build it.
        let server = serve(vec![]).await;
        let request = client().unwrap().get(format!("{}/v1/models", server.base)).header("x-api-key", "a\nb");
        assert_eq!(fetch_json::<Body>(request).await.unwrap_err(), ModelListError::InvalidKey);
    }

    #[test]
    fn a_blank_key_asks_nothing() {
        assert_eq!(require_key(None), Err(ModelListError::MissingKey));
        assert_eq!(require_key(Some("  ".into())), Err(ModelListError::MissingKey));
        assert_eq!(require_key(Some(" sk ".into())), Ok("sk".to_string()));
    }

    #[test]
    fn errors_serialize_with_their_kind() {
        let value = serde_json::to_value(ModelListError::KeyRejected { status: 401 }).unwrap();
        assert_eq!(value, serde_json::json!({"kind": "keyRejected", "status": 401}));
        let value = serde_json::to_value(ModelListError::MissingKey).unwrap();
        assert_eq!(value, serde_json::json!({"kind": "missingKey"}));
    }
}
