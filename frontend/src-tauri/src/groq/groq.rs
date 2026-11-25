use crate::cloud_models::{self, ModelListError};
use serde::{Deserialize, Serialize};
use tauri::command;

const API_BASE: &str = "https://api.groq.com/openai";

/// Groq model information returned to frontend
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct GroqModel {
    pub id: String,
    pub owned_by: Option<String>,
}

/// API response model from Groq (OpenAI-compatible format)
#[derive(Debug, Deserialize)]
struct GroqApiModel {
    id: String,
    owned_by: Option<String>,
}

/// `GET /models` answers the whole list at once, as OpenAI's does: it takes
/// no paging parameters.
#[derive(Debug, Deserialize)]
struct GroqApiResponse {
    data: Vec<GroqApiModel>,
}

/// Check if model is a chat-capable model (filter out whisper, etc.)
fn is_chat_model(model_id: &str) -> bool {
    let id = model_id.to_lowercase();
    // Exclude whisper, tool-use specific models, and embedding models
    !id.contains("whisper")
        && !id.contains("embed")
        && !id.contains("guard")
        && !id.contains("tool-use")
}

async fn list_models(base: &str, api_key: &str) -> Result<Vec<GroqModel>, ModelListError> {
    let request = cloud_models::client()
        .get(format!("{base}/v1/models"))
        .header("Authorization", format!("Bearer {api_key}"));
    let response: GroqApiResponse = cloud_models::fetch_json(request).await?;
    Ok(response
        .data
        .into_iter()
        .filter(|m| is_chat_model(&m.id))
        .map(|m| GroqModel { id: m.id, owned_by: m.owned_by })
        .collect())
}

/// The models Groq lists for `api_key`. No key, a rejected key or no answer
/// is an error (`cloud_models`), never a built-in list.
#[command]
pub async fn get_groq_models(api_key: Option<String>) -> Result<Vec<GroqModel>, ModelListError> {
    let api_key = cloud_models::require_key(api_key)?;
    let result = list_models(API_BASE, &api_key).await;
    cloud_models::log_outcome("Groq", &result);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_models::test_server::{json, serve};

    #[tokio::test]
    async fn lists_chat_models_with_the_bearer_key() {
        let server = serve(vec![json(
            200,
            r#"{"object":"list","data":[{"id":"llama-3.3-70b-versatile","object":"model","owned_by":"Meta"},{"id":"whisper-large-v3","object":"model","owned_by":"OpenAI"}]}"#,
        )])
        .await;
        let models = list_models(&server.base, "gsk-test").await.unwrap();
        assert_eq!(models, vec![GroqModel { id: "llama-3.3-70b-versatile".into(), owned_by: Some("Meta".into()) }]);
        let requests = server.requests.lock().unwrap();
        assert!(requests[0].starts_with("GET /v1/models "), "{}", requests[0]);
        assert!(requests[0].to_lowercase().contains("authorization: bearer gsk-test"));
    }

    #[tokio::test]
    async fn a_forbidden_key_is_an_error_not_a_list() {
        let server = serve(vec![json(403, "{}")]).await;
        assert_eq!(list_models(&server.base, "gsk").await, Err(ModelListError::KeyRejected { status: 403 }));
    }
}
