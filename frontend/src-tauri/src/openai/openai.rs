use crate::cloud_models::{self, ModelListError};
use serde::{Deserialize, Serialize};
use tauri::command;

const API_BASE: &str = "https://api.openai.com";

/// OpenAI model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct OpenAIModel {
    pub id: String,
}

/// API response model from OpenAI
#[derive(Debug, Deserialize)]
struct OpenAIApiModel {
    id: String,
}

/// `GET /v1/models` answers the whole list at once: it takes no paging
/// parameters.
#[derive(Debug, Deserialize)]
struct OpenAIApiResponse {
    data: Vec<OpenAIApiModel>,
}

/// Check if model is a chat-capable model (filter out embedding, tts, etc.)
fn is_chat_model(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    // Include gpt-*, o1-*, o3-*, o4-* models
    // Exclude embedding, tts, whisper, dall-e, babbage, davinci (non-chat models)
    (id.starts_with("gpt-")
        || id.starts_with("o1-")
        || id.starts_with("o3-")
        || id.starts_with("o4-")
        || id.starts_with("chatgpt-"))
        && !id.contains("embedding")
        && !id.contains("tts")
        && !id.contains("whisper")
        && !id.contains("dall-e")
        && !id.contains("babbage")
        && !id.contains("davinci")
        && !id.contains("instruct")
        && !id.contains("realtime")
        && !id.contains("audio")
}

async fn list_models(base: &str, api_key: &str) -> Result<Vec<OpenAIModel>, ModelListError> {
    let request = cloud_models::client()
        .get(format!("{base}/v1/models"))
        .header("Authorization", format!("Bearer {api_key}"));
    let response: OpenAIApiResponse = cloud_models::fetch_json(request).await?;
    Ok(response
        .data
        .into_iter()
        .filter(|m| is_chat_model(&m.id))
        .map(|m| OpenAIModel { id: m.id })
        .collect())
}

/// The models OpenAI lists for `api_key`. No key, a rejected key or no
/// answer is an error (`cloud_models`), never a built-in list; a key whose
/// project allows no chat model gets an empty list, which the UI says.
#[command]
pub async fn get_openai_models(api_key: Option<String>) -> Result<Vec<OpenAIModel>, ModelListError> {
    let api_key = cloud_models::require_key(api_key)?;
    let result = list_models(API_BASE, &api_key).await;
    cloud_models::log_outcome("OpenAI", &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_models::test_server::{json, serve};

    #[tokio::test]
    async fn lists_chat_models_only() {
        let server = serve(vec![json(
            200,
            r#"{"object":"list","data":[{"id":"gpt-4o","object":"model","owned_by":"system"},{"id":"text-embedding-3-small","object":"model","owned_by":"system"}]}"#,
        )])
        .await;
        assert_eq!(list_models(&server.base, "sk").await.unwrap(), vec![OpenAIModel { id: "gpt-4o".into() }]);
    }

    #[tokio::test]
    async fn a_rejected_key_is_an_error_not_a_list() {
        let server = serve(vec![json(401, r#"{"error":{"code":"invalid_api_key"}}"#)]).await;
        assert_eq!(list_models(&server.base, "sk").await, Err(ModelListError::KeyRejected { status: 401 }));
    }

    #[tokio::test]
    async fn a_server_error_keeps_its_status() {
        let server = serve(vec![json(503, "{}")]).await;
        assert_eq!(
            list_models(&server.base, "sk").await,
            Err(ModelListError::Status { status: 503, reason: Some("Service Unavailable".into()) })
        );
    }
}
