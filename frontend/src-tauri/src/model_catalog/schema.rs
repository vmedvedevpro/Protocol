//! The catalog document and the rules an entry must meet before the app uses
//! it. `scripts/model-catalog/check-catalog.mjs` applies the same rules in pull
//! requests; both run the shared cases in
//! `scripts/model-catalog/test/entry-cases.json`.
//!
//! An entry that breaks a rule is hidden on its own, so one bad entry in the
//! file on `main` cannot take the other models away. Only a document the app
//! cannot read at all (not JSON, another schema, no model list) is refused as
//! a whole.

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// The format of the catalog document this build reads.
pub const SCHEMA: u64 = 1;

/// The files of a Parakeet model, in the order the engine downloads them.
pub const PARAKEET_FILES: [&str; 4] =
    ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "nemo128.onnx", "vocab.txt"];

/// Chat templates `summary_engine::models::format_prompt` knows.
pub const CHAT_FORMATS: [&str; 2] = ["gemma3", "qwen3.5_nonthinking"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Whisper,
    Parakeet,
    /// Built-in summary models, run by llama-helper.
    Llama,
}

impl Engine {
    pub fn as_str(self) -> &'static str {
        match self {
            Engine::Whisper => "whisper",
            Engine::Parakeet => "parakeet",
            Engine::Llama => "llama",
        }
    }

    /// The file formats this build can run for the engine.
    fn formats(self) -> &'static [&'static str] {
        match self {
            Engine::Whisper => &["ggml"],
            Engine::Parakeet => &["onnx-tdt-int8"],
            Engine::Llama => &["gguf"],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct License {
    pub name: String,
    pub url: String,
}

/// One file of a model: `name` on disk, `path` in the Hugging Face repository.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogFile {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sampling {
    pub temperature: f32,
    pub top_k: i32,
    pub top_p: f32,
    pub presence_penalty: f32,
    pub frequency_penalty: f32,
    pub repeat_penalty: f32,
    pub penalty_last_n: i32,
}

/// What llama-helper needs besides the file. The chat template stays code:
/// `chat_format` names one of [`CHAT_FORMATS`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlamaParams {
    pub chat_format: String,
    pub context_size: u32,
    pub sampling: Sampling,
    pub stop_tokens: Vec<String>,
}

/// A model the app can offer. `id` is the value saved in settings, so it never
/// changes; the version is not here but resolved from Hugging Face (`repo`,
/// optionally pinned to the commit `revision`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub engine: Engine,
    pub format: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub languages: Vec<String>,
    #[serde(default)]
    pub accuracy: Option<String>,
    #[serde(default)]
    pub speed: Option<String>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub recommended: bool,
    /// False: not offered for new downloads; an installed copy keeps working.
    #[serde(default = "listed_by_default")]
    pub listed: bool,
    /// Summary models: which one "best available" picks first.
    #[serde(default)]
    pub rank: u32,
    /// Summary models: recommended only with at least this much RAM.
    #[serde(default)]
    pub min_ram_gb: Option<f64>,
    /// Approximate download size for display before Hugging Face is asked.
    pub size_mb: u64,
    pub license: License,
    pub repo: String,
    #[serde(default)]
    pub revision: Option<String>,
    pub files: Vec<CatalogFile>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub params: Option<LlamaParams>,
}

fn listed_by_default() -> bool {
    true
}

static ID: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[a-z0-9][a-z0-9._:-]{0,63}$").unwrap());
static REPO: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}/[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$").unwrap());
static COMMIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9a-f]{40}$").unwrap());
static FILE_NAME: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").unwrap());
static LANGUAGE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(\*|[a-z]{2,3})$").unwrap());
static VERSION: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+\.\d+\.\d+$").unwrap());

fn is_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.chars().count() <= max
}

fn is_repo_path(path: &str) -> bool {
    path.len() <= 255 && path.split('/').all(|segment| FILE_NAME.is_match(segment))
}

impl Entry {
    /// The rules serde does not check, as sentences; empty when the entry can
    /// be used. Mirrors `entryProblems` in check-catalog.mjs.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if !ID.is_match(&self.id) {
            problems.push("id must be 1-64 lowercase letters, digits, \".\", \"_\", \":\" or \"-\"".to_string());
        }
        if !self.engine.formats().contains(&self.format.as_str()) {
            problems.push(format!("format {:?} is not supported by {}", self.format, self.engine.as_str()));
        }
        if !is_text(&self.name, 80) {
            problems.push("name must be a non-empty text of at most 80 characters".to_string());
        }
        if self.description.chars().count() > 300 {
            problems.push("description must be a text of at most 300 characters".to_string());
        }
        if self.languages.is_empty() || !self.languages.iter().all(|code| LANGUAGE.is_match(code)) {
            problems.push("languages must list \"*\" or language codes".to_string());
        }
        for (field, value) in [("accuracy", &self.accuracy), ("speed", &self.speed)] {
            if value.as_deref().is_some_and(|value| !is_text(value, 40)) {
                problems.push(format!("{field} must be a short text"));
            }
        }
        if self.tier.as_deref().is_some_and(|tier| tier != "basic" && tier != "advanced") {
            problems.push("tier must be \"basic\" or \"advanced\"".to_string());
        }
        if self.min_ram_gb.is_some_and(|gb| !(gb > 0.0)) {
            problems.push("min_ram_gb must be a positive number".to_string());
        }
        if self.size_mb == 0 {
            problems.push("size_mb must be a positive whole number".to_string());
        }
        if !is_text(&self.license.name, 80) || !self.license.url.starts_with("https://") {
            problems.push("license needs a name and an https url".to_string());
        }
        if !REPO.is_match(&self.repo) {
            problems.push("repo must be a Hugging Face repository, owner/name".to_string());
        }
        if self.revision.as_deref().is_some_and(|revision| !COMMIT.is_match(revision)) {
            problems.push("revision must be a full 40-character commit id".to_string());
        }
        if self.min_app_version.as_deref().is_some_and(|version| !VERSION.is_match(version)) {
            problems.push("min_app_version must be X.Y.Z".to_string());
        }
        problems.extend(self.file_problems());
        match (self.engine, &self.params) {
            (Engine::Llama, Some(params)) => problems.extend(llama_problems(params)),
            (Engine::Llama, None) => problems.push("params are required for llama".to_string()),
            (engine, Some(_)) => problems.push(format!("params are not used by {}", engine.as_str())),
            (_, None) => {}
        }
        problems
    }

    fn file_problems(&self) -> Vec<String> {
        if self.files.is_empty() {
            return vec!["files must list at least one file".to_string()];
        }
        let mut problems = Vec::new();
        let mut names = HashSet::new();
        for file in &self.files {
            if !FILE_NAME.is_match(&file.name) || !is_repo_path(&file.path) {
                problems.push("every file needs a safe name and a relative path in the repository".to_string());
                continue;
            }
            if !names.insert(file.name.as_str()) {
                problems.push(format!("file {} is listed twice", file.name));
            }
        }
        if !problems.is_empty() {
            return problems;
        }
        match self.engine {
            Engine::Whisper if self.files.len() != 1 || self.files[0].name != format!("ggml-{}.bin", self.id) => {
                problems.push(format!("a whisper model is one file named ggml-{}.bin", self.id));
            }
            Engine::Parakeet
                if self.files.len() != PARAKEET_FILES.len() || !PARAKEET_FILES.iter().all(|name| names.contains(name)) =>
            {
                problems.push(format!("a parakeet model is the files {}", PARAKEET_FILES.join(", ")));
            }
            Engine::Llama if self.files.len() != 1 || !self.files[0].name.ends_with(".gguf") => {
                problems.push("a llama model is one .gguf file".to_string());
            }
            _ => {}
        }
        problems
    }

    /// The single file of a Whisper or summary model.
    pub fn single_file(&self) -> &CatalogFile {
        &self.files[0]
    }

    /// Whether this build may offer the entry: its `min_app_version` is not
    /// above `app_version`. Engines, formats and chat formats this build does
    /// not know never get this far (see [`Entry::problems`]).
    pub fn runs_on(&self, app_version: &str) -> bool {
        match &self.min_app_version {
            None => true,
            Some(minimum) => version_triple(app_version) >= version_triple(minimum),
        }
    }
}

fn llama_problems(params: &LlamaParams) -> Vec<String> {
    let mut problems = Vec::new();
    if !CHAT_FORMATS.contains(&params.chat_format.as_str()) {
        problems.push(format!("chat_format must be one of {}", CHAT_FORMATS.join(", ")));
    }
    if !(512..=1_048_576).contains(&params.context_size) {
        problems.push("context_size must be a whole number from 512 to 1048576".to_string());
    }
    let sampling = &params.sampling;
    let finite = [
        sampling.temperature,
        sampling.top_p,
        sampling.presence_penalty,
        sampling.frequency_penalty,
        sampling.repeat_penalty,
    ];
    if !finite.iter().all(|value| value.is_finite()) {
        problems.push("sampling values must be finite numbers".to_string());
    }
    if params.stop_tokens.is_empty() || params.stop_tokens.iter().any(String::is_empty) {
        problems.push("stop_tokens must list at least one token".to_string());
    }
    problems
}

/// `X.Y.Z` (an `-rc.N` suffix is ignored) as numbers for comparison; anything
/// unreadable counts as 0.0.0.
pub fn version_triple(version: &str) -> (u64, u64, u64) {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

/// An entry that was left out, and why.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hidden {
    pub index: usize,
    pub id: Option<String>,
    pub problem: String,
}

/// A readable catalog: the usable entries in file order and the hidden ones.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Catalog {
    pub entries: Vec<Entry>,
    pub hidden: Vec<Hidden>,
}

/// Why a document cannot be used at all.
#[derive(Debug, Clone, PartialEq)]
pub enum DocumentError {
    NotJson(String),
    /// A catalog for another format, typically one a newer app reads.
    Schema(String),
    NoModels,
}

impl std::fmt::Display for DocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotJson(error) => write!(f, "the model list is not valid JSON ({error})"),
            Self::Schema(found) => write!(f, "the model list has schema {found}; this version of Protocol reads schema {SCHEMA}"),
            Self::NoModels => write!(f, "the model list has no list of models"),
        }
    }
}

impl std::error::Error for DocumentError {}

/// Reads a catalog document. Mirrors `catalogProblems` in check-catalog.mjs:
/// of two entries with the same engine and id, or two summary models with the
/// same file name (they share one folder), the first is kept.
pub fn parse(bytes: &[u8]) -> Result<Catalog, DocumentError> {
    let document: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| DocumentError::NotJson(error.to_string()))?;
    let Some(object) = document.as_object() else {
        return Err(DocumentError::NotJson("not an object".to_string()));
    };
    match object.get("schema") {
        Some(schema) if schema.as_u64() == Some(SCHEMA) => {}
        other => return Err(DocumentError::Schema(other.map_or_else(|| "none".to_string(), ToString::to_string))),
    }
    let Some(models) = object.get("models").and_then(|models| models.as_array()) else {
        return Err(DocumentError::NoModels);
    };

    let mut catalog = Catalog::default();
    let mut ids = HashSet::new();
    let mut gguf_names = HashSet::new();
    for (index, value) in models.iter().enumerate() {
        let id = value.get("id").and_then(|id| id.as_str()).map(str::to_string);
        let hide = |problem: String| Hidden { index, id: id.clone(), problem };
        let entry = match serde_json::from_value::<Entry>(value.clone()) {
            Ok(entry) => entry,
            Err(error) => {
                catalog.hidden.push(hide(error.to_string()));
                continue;
            }
        };
        let problems = entry.problems();
        if !problems.is_empty() {
            catalog.hidden.extend(problems.into_iter().map(hide));
            continue;
        }
        let key = (entry.engine, entry.id.clone());
        if ids.contains(&key) {
            catalog.hidden.push(hide(format!("{}/{} is listed twice", entry.engine.as_str(), entry.id)));
            continue;
        }
        if entry.engine == Engine::Llama && gguf_names.contains(&entry.single_file().name) {
            catalog.hidden.push(hide(format!("{} is already used by another summary model", entry.single_file().name)));
            continue;
        }
        ids.insert(key);
        if entry.engine == Engine::Llama {
            gguf_names.insert(entry.single_file().name.clone());
        }
        catalog.entries.push(entry);
    }
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../../../scripts/model-catalog/test/entry-cases.json");

    /// The base entry with the case's dotted paths set and removed, as in
    /// check-catalog.test.mjs.
    fn case_entry(cases: &Value, case: &Value) -> Value {
        let mut entry = cases["bases"][case["base"].as_str().unwrap()].clone();
        let mut walk = |path: &str, apply: &mut dyn FnMut(&mut serde_json::Map<String, Value>, &str)| {
            let mut keys: Vec<&str> = path.split('.').collect();
            let last = keys.pop().unwrap();
            let mut node = &mut entry;
            for key in keys {
                node = node.get_mut(key).unwrap();
            }
            apply(node.as_object_mut().unwrap(), last);
        };
        if let Some(set) = case.get("set").and_then(Value::as_object) {
            for (path, value) in set {
                walk(path, &mut |node, key| {
                    node.insert(key.to_string(), value.clone());
                });
            }
        }
        if let Some(remove) = case.get("remove").and_then(Value::as_array) {
            for path in remove {
                walk(path.as_str().unwrap(), &mut |node, key| {
                    node.remove(key);
                });
            }
        }
        entry
    }

    #[test]
    fn the_shared_cases_agree_with_the_pull_request_check() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let entry = case_entry(&cases, case);
            let document = serde_json::json!({ "schema": 1, "models": [entry] });
            let catalog = parse(document.to_string().as_bytes()).unwrap();
            let valid = catalog.hidden.is_empty();
            assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}: {:?}", case["name"], catalog.hidden);
            assert_eq!(catalog.entries.len(), usize::from(valid));
        }
    }

    #[test]
    fn a_document_that_cannot_be_read_is_refused_whole() {
        assert!(matches!(parse(b"<html>"), Err(DocumentError::NotJson(_))));
        assert!(matches!(parse(b"[]"), Err(DocumentError::NotJson(_))));
        let error = parse(br#"{"schema": 2, "models": []}"#).unwrap_err();
        assert_eq!(error, DocumentError::Schema("2".to_string()));
        assert!(error.to_string().contains("reads schema 1"));
        assert_eq!(parse(br#"{"schema": 1}"#).unwrap_err(), DocumentError::NoModels);
    }

    #[test]
    fn a_broken_entry_is_hidden_alone_and_the_first_duplicate_wins() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let whisper = cases["bases"]["whisper"].clone();
        let llama = cases["bases"]["llama"].clone();
        let mut nameless = whisper.clone();
        nameless["name"] = Value::from("");
        let mut renamed = llama.clone();
        renamed["id"] = Value::from("gemma3:1b-copy");
        let mut second = whisper.clone();
        second["name"] = Value::from("Second");
        let document = serde_json::json!({ "schema": 1, "models": [whisper, nameless, second, llama, renamed] });
        let catalog = parse(document.to_string().as_bytes()).unwrap();
        assert_eq!(catalog.hidden.iter().map(|hidden| hidden.index).collect::<Vec<_>>(), [1, 2, 4]);
        assert_eq!(catalog.entries.len(), 2);
        assert_eq!(catalog.entries[0].name, "Whisper tiny");
        assert!(catalog.hidden[1].problem.contains("whisper/tiny is listed twice"));
        assert!(catalog.hidden[2].problem.contains("already used by another summary model"));
    }

    #[test]
    fn min_app_version_hides_entries_for_newer_apps() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let mut entry: Entry = serde_json::from_value(cases["bases"]["whisper"].clone()).unwrap();
        assert!(entry.runs_on("0.3.0"));
        entry.min_app_version = Some("0.4.0".to_string());
        assert!(!entry.runs_on("0.3.9"));
        assert!(entry.runs_on("0.4.0"));
        assert!(entry.runs_on("0.4.0-rc.1"));
        assert!(entry.runs_on("1.0.0"));
        assert_eq!(version_triple("0.10.2"), (0, 10, 2));
    }

    #[test]
    fn listed_defaults_to_true_and_unknown_fields_are_ignored() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let mut value = cases["bases"]["whisper"].clone();
        value["added_later"] = Value::from(true);
        let entry: Entry = serde_json::from_value(value).unwrap();
        assert!(entry.listed);
        assert!(!entry.recommended);
        assert!(entry.problems().is_empty());
    }
}
