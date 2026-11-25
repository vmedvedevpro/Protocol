use crate::cloud_models::{self, ModelListError};
use serde::{Deserialize, Serialize};
use tauri::command;

const API_BASE: &str = "https://api.anthropic.com";

/// The largest page the Models API serves; its default is 20, which would
/// hide every model past the twentieth.
const PAGE_LIMIT: u32 = 1000;

/// Pages asked before the answer counts as broken: a `has_more` that never
/// ends must not loop, and ten full pages are far past any real list.
const MAX_PAGES: usize = 10;

/// Anthropic (Claude) model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct AnthropicModel {
    pub id: String,
    pub display_name: Option<String>,
}

/// API response model from Anthropic
#[derive(Debug, Deserialize)]
struct AnthropicApiModel {
    id: String,
    display_name: Option<String>,
}

/// One page of `GET /v1/models`: the next page starts after `last_id`.
#[derive(Debug, Deserialize)]
struct AnthropicApiPage {
    data: Vec<AnthropicApiModel>,
    #[serde(default)]
    has_more: bool,
    last_id: Option<String>,
}

/// Check if model is a chat-capable model
fn is_chat_model(model_id: &str) -> bool {
    model_id.to_lowercase().starts_with("claude-")
}

/// Every page of the key's models from `base`, the API's origin.
async fn list_models(base: &str, api_key: &str) -> Result<Vec<AnthropicModel>, ModelListError> {
    let client = cloud_models::client();
    let mut models = Vec::new();
    let mut after_id: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut request = client
            .get(format!("{base}/v1/models"))
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .query(&[("limit", PAGE_LIMIT.to_string())]);
        if let Some(after) = &after_id {
            request = request.query(&[("after_id", after)]);
        }
        let page: AnthropicApiPage = cloud_models::fetch_json(request).await?;
        models.extend(page.data.into_iter().filter(|m| is_chat_model(&m.id)).map(|m| AnthropicModel {
            id: m.id,
            display_name: m.display_name,
        }));
        match (page.has_more, page.last_id) {
            (true, Some(last)) => after_id = Some(last),
            (true, None) => {
                return Err(ModelListError::InvalidResponse { reason: "a page said more follow but named no last model".into() })
            }
            (false, _) => return Ok(models),
        }
    }
    Err(ModelListError::InvalidResponse { reason: format!("the list did not end after {MAX_PAGES} pages") })
}

/// The models Anthropic lists for `api_key`, every page of them. No key, a
/// rejected key or no answer is an error (`cloud_models`), never a built-in
/// list.
#[command]
pub async fn get_anthropic_models(api_key: Option<String>) -> Result<Vec<AnthropicModel>, ModelListError> {
    let api_key = cloud_models::require_key(api_key)?;
    let result = list_models(API_BASE, &api_key).await;
    cloud_models::log_outcome("Anthropic", &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_models::test_server::{json, serve};

    #[tokio::test]
    async fn follows_every_page() {
        let server = serve(vec![
            json(200, r#"{"data":[{"id":"claude-a","display_name":"A"}],"has_more":true,"last_id":"claude-a"}"#),
            json(200, r#"{"data":[{"id":"claude-b","display_name":null}],"has_more":false,"last_id":"claude-b"}"#),
        ])
        .await;
        let models = list_models(&server.base, "sk-test").await.unwrap();
        assert_eq!(
            models,
            vec![
                AnthropicModel { id: "claude-a".into(), display_name: Some("A".into()) },
                AnthropicModel { id: "claude-b".into(), display_name: None },
            ]
        );
        let requests = server.requests.lock().unwrap();
        assert!(requests[0].starts_with("GET /v1/models?limit=1000 "), "{}", requests[0]);
        assert!(requests[1].starts_with("GET /v1/models?limit=1000&after_id=claude-a "), "{}", requests[1]);
        assert!(requests[0].to_lowercase().contains("x-api-key: sk-test"));
    }

    #[tokio::test]
    async fn a_rejected_key_is_an_error_not_a_list() {
        let server = serve(vec![json(401, r#"{"type":"error","error":{"type":"authentication_error"}}"#)]).await;
        assert_eq!(list_models(&server.base, "sk-bad").await, Err(ModelListError::KeyRejected { status: 401 }));
    }

    #[tokio::test]
    async fn an_endless_list_stops() {
        let page = r#"{"data":[],"has_more":true,"last_id":"x"}"#;
        let server = serve((0..MAX_PAGES).map(|_| json(200, page)).collect()).await;
        assert!(matches!(list_models(&server.base, "sk").await, Err(ModelListError::InvalidResponse { .. })));
    }

    #[tokio::test]
    async fn no_key_asks_nothing() {
        assert_eq!(get_anthropic_models(Some(" ".into())).await, Err(ModelListError::MissingKey));
    }
}
