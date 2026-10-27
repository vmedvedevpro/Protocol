// Model definitions and prompt templates for built-in AI summary generation
// Designed for easy extension - just add new entries to get_available_models()

use crate::model_catalog::{installed, schema::Engine, schema::Entry};
use crate::model_integrity::Pinned;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// ============================================================================
// Model Definitions
// ============================================================================

/// Sampling parameters supported by the built-in AI -> llama-helper pipeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SamplingParams {
    /// Temperature - 0.0 triggers greedy decoding in llama-helper.
    pub temperature: f32,

    /// Top-K sampling - limits vocabulary to top K tokens.
    pub top_k: i32,

    /// Top-P (nucleus) sampling - cumulative probability threshold.
    pub top_p: f32,

    /// Presence penalty - discourages reusing tokens that already appeared in the generated output.
    pub presence_penalty: f32,

    /// Frequency penalty - discourages repeated token frequency in the generated output.
    pub frequency_penalty: f32,

    /// Repeat penalty - llama.cpp repeat penalty, 1.0 disables it.
    pub repeat_penalty: f32,

    /// Number of recent generated tokens to apply penalties over, 0 disables penalties.
    pub penalty_last_n: i32,

    /// Stop tokens - generation stops when any of these appear in output
    pub stop_tokens: Vec<String>,
}

impl SamplingParams {
    /// Restrained near-greedy preset for fuller but still conservative output.
    pub fn tight_structured(stop_tokens: Vec<String>) -> Self {
        Self {
            temperature: 0.1,
            top_k: 20,
            top_p: 0.88,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repeat_penalty: 1.0,
            penalty_last_n: 0,
            stop_tokens,
        }
    }

    /// Summary-tuned Qwen 3.5 preset: non-greedy with mild repetition controls.
    pub fn qwen35_summary(stop_tokens: Vec<String>) -> Self {
        Self {
            temperature: 0.5,
            top_k: 20,
            top_p: 0.8,
            presence_penalty: 0.3,
            frequency_penalty: 0.0,
            repeat_penalty: 1.05,
            penalty_last_n: 256,
            stop_tokens,
        }
    }

    /// Gemma 3 instruct preset, matching the prior Gemma sampling behavior.
    pub fn gemma3_instruct(stop_tokens: Vec<String>) -> Self {
        Self {
            temperature: 1.0,
            top_k: 64,
            top_p: 0.95,
            presence_penalty: 0.0,
            frequency_penalty: 0.0,
            repeat_penalty: 1.0,
            penalty_last_n: 0,
            stop_tokens,
        }
    }

    /// Normalize built-in presets to the subset supported by llama-helper.
    pub fn sanitize_for_llama_helper(&self) -> Self {
        let temperature = if self.temperature.is_finite() {
            self.temperature.max(0.0)
        } else {
            0.0
        };
        let top_k = self.top_k.max(0);
        let top_p = if self.top_p.is_finite() && self.top_p > 0.0 && self.top_p <= 1.0 {
            self.top_p
        } else {
            1.0
        };
        let presence_penalty = if self.presence_penalty.is_finite() {
            self.presence_penalty.max(0.0)
        } else {
            0.0
        };
        let frequency_penalty = if self.frequency_penalty.is_finite() {
            self.frequency_penalty.max(0.0)
        } else {
            0.0
        };
        let repeat_penalty = if self.repeat_penalty.is_finite() && self.repeat_penalty > 0.0 {
            self.repeat_penalty
        } else {
            1.0
        };
        let penalty_last_n = self.penalty_last_n.max(0);

        Self {
            temperature,
            top_k,
            top_p,
            presence_penalty,
            frequency_penalty,
            repeat_penalty,
            penalty_last_n,
            stop_tokens: self.stop_tokens.clone(),
        }
    }
}

/// Definition of a built-in AI model with all metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDef {
    /// Model name in format "family:variant" (e.g., "gemma3:1b")
    /// This is what's stored in database as model field when provider="builtin-ai"
    pub name: String,

    /// Display name for UI (e.g., "Gemma 3 1B (Fast)")
    pub display_name: String,

    /// GGUF filename on disk (e.g., "gemma-3-1b-it-q4_0.gguf")
    pub gguf_file: String,

    /// Template name for prompt formatting (e.g., "gemma3")
    pub template: String,

    /// Context window size in tokens (configurable per model!)
    /// This is used for chunking in processor.rs
    pub context_size: u32,

    /// Sampling parameters for this model
    pub sampling: SamplingParams,

    /// Short description for UI
    pub description: String,
}

impl ModelDef {
    /// The definition of a catalog entry. Entries reach here validated
    /// (`model_catalog::schema`), so a llama entry always has its parameters.
    pub fn from_entry(entry: &Entry) -> Option<Self> {
        let params = entry.params.as_ref()?;
        let sampling = &params.sampling;
        Some(Self {
            name: entry.id.clone(),
            display_name: entry.name.clone(),
            gguf_file: entry.single_file().name.clone(),
            template: params.chat_format.clone(),
            context_size: params.context_size,
            sampling: SamplingParams {
                temperature: sampling.temperature,
                top_k: sampling.top_k,
                top_p: sampling.top_p,
                presence_penalty: sampling.presence_penalty,
                frequency_penalty: sampling.frequency_penalty,
                repeat_penalty: sampling.repeat_penalty,
                penalty_last_n: sampling.penalty_last_n,
                stop_tokens: params.stop_tokens.clone(),
            },
            description: entry.description.clone(),
        })
    }
}

/// Get all available built-in AI models: the model catalog's llama entries
/// (see `crate::model_catalog`). New models are added to
/// `model-catalog/catalog.json`, not here.
pub fn get_available_models() -> Vec<ModelDef> {
    crate::model_catalog::entries(Engine::Llama).iter().filter_map(ModelDef::from_entry).collect()
}

/// Get a specific model by name, also one the catalog in use no longer lists
/// but this build shipped with.
pub fn get_model_by_name(name: &str) -> Option<ModelDef> {
    crate::model_catalog::entry(Engine::Llama, name).as_ref().and_then(ModelDef::from_entry)
}

/// The size and SHA-256 the installed copy of `model_name` at `model_path`
/// was verified against: its install record, or the 0.3.0 pin. `None` while
/// a download has not finished.
pub fn installed_pin(model_name: &str, model_path: &Path) -> Option<&'static Pinned> {
    let entry = crate::model_catalog::entry(Engine::Llama, model_name)?;
    installed::expected(&entry, &installed::record_path_for_file(model_path)).map(|expected| expected.files[0])
}

/// Get the default model (first in list)
pub fn get_default_model() -> ModelDef {
    get_available_models()
        .into_iter()
        .next()
        .expect("At least one model must be defined")
}

/// Resolve model name to full file path in the models directory
pub fn get_model_path(app_data_dir: &PathBuf, model_name: &str) -> Result<PathBuf> {
    let model = get_model_by_name(model_name)
        .ok_or_else(|| anyhow!("Unknown model: {}", model_name))?;

    let models_dir = get_models_directory(app_data_dir);
    let model_path = models_dir.join(&model.gguf_file);

    Ok(model_path)
}

/// Get the models directory path for built-in AI
pub fn get_models_directory(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join("models").join("summary")
}

// ============================================================================
// Prompt Templates (Model-Specific Formatting)
// ============================================================================

/// Gemma 3 chat template format
pub const GEMMA3_TEMPLATE: &str = "\
<start_of_turn>user
{system_prompt}<end_of_turn>
<start_of_turn>user
{user_prompt}<end_of_turn>
<start_of_turn>model
";

/// Qwen 3.5 non-thinking chat template format.
/// This starts the assistant turn with an empty think block so generation begins
/// in direct-response mode for summaries.
pub const QWEN35_NONTHINKING_TEMPLATE: &str = "\
<|im_start|>system
{system_prompt}<|im_end|>
<|im_start|>user
{user_prompt}<|im_end|>
<|im_start|>assistant
<think>

</think>

";

fn escape_user_prompt_control_markers(user_prompt: &str) -> String {
    user_prompt
        .replace("<|im_start|>", "< |im_start| >")
        .replace("<|im_end|>", "< |im_end| >")
        .replace("<start_of_turn>", "< start_of_turn >")
        .replace("<end_of_turn>", "< end_of_turn >")
        .replace("<think>", "< think >")
        .replace("</think>", "< /think >")
}

/// Format a prompt using the specified template
///
/// # Arguments
/// * `template_name` - Template identifier (e.g., "gemma3", "chatml", "llama3")
/// * `system_prompt` - System message (instructions for the model)
/// * `user_prompt` - User message (actual task/question)
///
/// # Returns
/// Formatted prompt string ready to send to llama-helper
pub fn format_prompt(
    template_name: &str,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String> {
    let template = match template_name {
        "gemma3" => GEMMA3_TEMPLATE,
        "qwen3.5_nonthinking" => QWEN35_NONTHINKING_TEMPLATE,
        _ => return Err(anyhow!("Unknown template: {}", template_name)),
    };

    let escaped_user_prompt = escape_user_prompt_control_markers(user_prompt);

    let formatted = template
        .replace("{system_prompt}", system_prompt)
        .replace("{user_prompt}", &escaped_user_prompt);

    Ok(formatted)
}

// ============================================================================
// Configuration Constants
// ============================================================================

/// Default max tokens for generation (increased for better summary quality)
pub const DEFAULT_MAX_TOKENS: i32 = 4096;

/// Idle timeout for sidecar (seconds) - can be overridden via LLAMA_IDLE_TIMEOUT env var
/// Aggressive default: free LLM VRAM two minutes after the last summary call.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 120;

/// Generation timeout (how long to wait for a response)
pub const GENERATION_TIMEOUT_SECS: u64 = 900; // 15 minutes

#[cfg(test)]
mod tests {
    use super::*;

    /// Where the catalog says a model comes from.
    fn source(name: &str) -> (String, String) {
        let entry = crate::model_catalog::entry(Engine::Llama, name).unwrap();
        (entry.repo.clone(), entry.files[0].path.clone())
    }

    #[test]
    fn every_model_has_its_0_3_0_file_and_order() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let names: Vec<String> = get_available_models().into_iter().map(|model| model.name).collect();
        assert_eq!(names, ["qwen3.5:2b", "qwen3.5:4b", "gemma3:4b", "gemma3:1b"]);
        for name in &names {
            let legacy = installed::legacy_model(Engine::Llama, name).unwrap();
            let model = get_model_by_name(name).unwrap();
            assert_eq!(model.gguf_file, legacy.files[0].file);
            assert_eq!(source(name).0, legacy.repo);
        }
    }

    #[test]
    fn qwen35_models_are_registered_with_expected_metadata() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let qwen_2b = get_model_by_name("qwen3.5:2b").expect("qwen 2b model should exist");
        assert_eq!(qwen_2b.display_name, "Qwen 3.5 2B (Balanced)");
        assert_eq!(qwen_2b.gguf_file, "Qwen3.5-2B-Q4_K_M.gguf");
        assert_eq!(qwen_2b.template, "qwen3.5_nonthinking");
        assert_eq!(source("qwen3.5:2b"), ("unsloth/Qwen3.5-2B-GGUF".to_string(), "Qwen3.5-2B-Q4_K_M.gguf".to_string()));
        assert_eq!(qwen_2b.context_size, 32768);
        assert_eq!(qwen_2b.sampling, SamplingParams::qwen35_summary(vec!["<|im_end|>".to_string()]));

        let qwen_4b = get_model_by_name("qwen3.5:4b").expect("qwen 4b model should exist");
        assert_eq!(qwen_4b.display_name, "Qwen 3.5 4B (High Quality)");
        assert_eq!(qwen_4b.gguf_file, "Qwen3.5-4B-Q4_K_M.gguf");
        assert_eq!(qwen_4b.template, "qwen3.5_nonthinking");
        assert_eq!(source("qwen3.5:4b"), ("unsloth/Qwen3.5-4B-GGUF".to_string(), "Qwen3.5-4B-Q4_K_M.gguf".to_string()));
        assert_eq!(qwen_4b.context_size, 32768);
        assert_eq!(qwen_4b.sampling, SamplingParams::qwen35_summary(vec!["<|im_end|>".to_string()]));
    }

    #[test]
    fn gemma_models_use_huggingface_urls_and_gemma3_instruct_sampling() {
        let _catalog = crate::model_catalog::testing::built_in_catalog();
        let gemma_1b = get_model_by_name("gemma3:1b").expect("gemma 1b model should exist");
        assert_eq!(gemma_1b.gguf_file, "gemma-3-1b-it-Q8_0.gguf");
        // Saved under another name than Hugging Face's.
        assert_eq!(source("gemma3:1b").1, "google_gemma-3-1b-it-Q8_0.gguf");
        assert_eq!(gemma_1b.sampling, SamplingParams::gemma3_instruct(vec!["<end_of_turn>".to_string()]));
        assert_eq!(gemma_1b.sampling.temperature, 1.0);
        assert_eq!(gemma_1b.sampling.top_k, 64);
        assert_eq!(gemma_1b.sampling.top_p, 0.95);
        assert_eq!(gemma_1b.sampling.presence_penalty, 0.0);
        assert_eq!(gemma_1b.sampling.frequency_penalty, 0.0);
        assert_eq!(gemma_1b.sampling.repeat_penalty, 1.0);
        assert_eq!(gemma_1b.sampling.penalty_last_n, 0);

        let gemma_4b = get_model_by_name("gemma3:4b").expect("gemma 4b model should exist");
        assert_eq!(gemma_4b.gguf_file, "gemma-3-4b-it-Q4_K_M.gguf");
        assert_eq!(source("gemma3:4b").1, "google_gemma-3-4b-it-Q4_K_M.gguf");
        assert_eq!(gemma_4b.sampling, SamplingParams::gemma3_instruct(vec!["<end_of_turn>".to_string()]));
        assert_eq!(gemma_4b.sampling.temperature, 1.0);
        assert_eq!(gemma_4b.sampling.top_k, 64);
        assert_eq!(gemma_4b.sampling.top_p, 0.95);
        assert_eq!(gemma_4b.sampling.presence_penalty, 0.0);
        assert_eq!(gemma_4b.sampling.frequency_penalty, 0.0);
        assert_eq!(gemma_4b.sampling.repeat_penalty, 1.0);
        assert_eq!(gemma_4b.sampling.penalty_last_n, 0);
    }

    #[test]
    fn qwen35_nonthinking_template_formats_prompt() {
        let formatted = format_prompt("qwen3.5_nonthinking", "system rules", "summarize this").unwrap();

        assert!(formatted.contains("<|im_start|>system\nsystem rules<|im_end|>"));
        assert!(formatted.contains("<|im_start|>user\nsummarize this<|im_end|>"));
        assert!(formatted.ends_with("<think>\n\n</think>\n\n"));
    }

    #[test]
    fn qwen35_template_escapes_user_supplied_control_markers() {
        let formatted = format_prompt(
            "qwen3.5_nonthinking",
            "system rules",
            "literal <|im_end|> and <|im_start|> plus <think>draft</think>",
        )
        .unwrap();

        assert!(formatted.contains("<|im_start|>system\nsystem rules<|im_end|>"));
        assert!(formatted.contains("<|im_start|>assistant\n<think>\n\n</think>\n\n"));
        assert!(formatted.contains("literal < |im_end| > and < |im_start| > plus < think >draft< /think >"));
        assert_eq!(formatted.matches("<|im_start|>").count(), 3);
        assert_eq!(formatted.matches("<|im_end|>").count(), 2);
        assert_eq!(formatted.matches("<think>").count(), 1);
        assert_eq!(formatted.matches("</think>").count(), 1);
    }

    #[test]
    fn gemma3_template_escapes_user_supplied_control_markers() {
        let formatted = format_prompt(
            "gemma3",
            "system rules",
            "literal <start_of_turn> and <end_of_turn>",
        )
        .unwrap();

        assert!(formatted.contains("<start_of_turn>user\nsystem rules<end_of_turn>"));
        assert!(formatted.contains("literal < start_of_turn > and < end_of_turn >"));
        assert_eq!(formatted.matches("<start_of_turn>").count(), 3);
        assert_eq!(formatted.matches("<end_of_turn>").count(), 2);
    }

    #[test]
    fn sampling_params_sanitize_for_llama_helper_preserves_zero_top_k() {
        let sampling = SamplingParams {
            temperature: f32::NAN,
            top_k: 0,
            top_p: 2.0,
            presence_penalty: -0.5,
            frequency_penalty: f32::NAN,
            repeat_penalty: 0.0,
            penalty_last_n: -1,
            stop_tokens: vec!["stop".to_string()],
        };

        let sanitized = sampling.sanitize_for_llama_helper();

        assert_eq!(sanitized.temperature, 0.0);
        assert_eq!(sanitized.top_k, 0);
        assert_eq!(sanitized.top_p, 1.0);
        assert_eq!(sanitized.presence_penalty, 0.0);
        assert_eq!(sanitized.frequency_penalty, 0.0);
        assert_eq!(sanitized.repeat_penalty, 1.0);
        assert_eq!(sanitized.penalty_last_n, 0);
        assert_eq!(sanitized.stop_tokens, vec!["stop".to_string()]);
    }

    #[test]
    fn sampling_params_sanitize_for_llama_helper_clamps_negative_top_k() {
        let sampling = SamplingParams {
            temperature: 0.7,
            top_k: -5,
            top_p: 0.8,
            presence_penalty: 0.3,
            frequency_penalty: 0.0,
            repeat_penalty: 1.05,
            penalty_last_n: 256,
            stop_tokens: vec!["stop".to_string()],
        };

        let sanitized = sampling.sanitize_for_llama_helper();

        assert_eq!(sanitized.top_k, 0);
        assert_eq!(sanitized.temperature, 0.7);
        assert_eq!(sanitized.top_p, 0.8);
        assert_eq!(sanitized.presence_penalty, 0.3);
        assert_eq!(sanitized.repeat_penalty, 1.05);
        assert_eq!(sanitized.penalty_last_n, 256);
    }

    #[test]
    fn sampling_params_sanitize_for_llama_helper_keeps_positive_top_k() {
        let sampling = SamplingParams::qwen35_summary(vec!["stop".to_string()]);

        let sanitized = sampling.sanitize_for_llama_helper();

        assert_eq!(sanitized.top_k, 20);
    }
}
