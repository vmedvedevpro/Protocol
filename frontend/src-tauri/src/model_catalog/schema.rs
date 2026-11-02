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

/// The format of a Whisper model exported to OpenVINO IR by `optimum-intel`,
/// run by OpenVINO GenAI on an Intel GPU (#79). Such an entry is a companion:
/// it is never offered as a model of its own, only beside the ggml models it
/// names in `companion_of` (`super::openvino`).
pub const OPENVINO_IR: &str = "openvino-ir";

/// The files of an OpenVINO Whisper model that GenAI's `WhisperPipeline`
/// reads, as `OpenVINO/whisper-*-ov` on Hugging Face has them; the engine
/// checks the same list (`whisper_engine::openvino::MODEL_FILES`).
pub const OPENVINO_WHISPER_FILES: [&str; 11] = [
    "openvino_encoder_model.xml",
    "openvino_encoder_model.bin",
    "openvino_decoder_model.xml",
    "openvino_decoder_model.bin",
    "openvino_tokenizer.xml",
    "openvino_tokenizer.bin",
    "openvino_detokenizer.xml",
    "openvino_detokenizer.bin",
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
];

/// The OpenVINO GenAI runtime that runs `openvino-ir` companions
/// (`whisper_engine::openvino::genai`).
pub const OPENVINO_GENAI: &str = "openvino-genai";

/// The inference runtimes this build can load (#79): the catalog id, the
/// platforms it loads each on, and the libraries its binding opens by name.
/// Mirrors `RUNTIMES` in check-catalog.mjs.
const RUNTIMES: [(&str, &[&str], &[&str]); 1] =
    [(OPENVINO_GENAI, &["windows-x86_64"], &["openvino_genai_c.dll", "openvino_c.dll"])];

/// This build's platform as the catalog's runtimes name it.
pub fn platform() -> &'static str {
    if cfg!(all(windows, target_arch = "x86_64")) {
        "windows-x86_64"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "linux-x86_64"
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "macos-aarch64"
    } else {
        "other"
    }
}

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
            Engine::Whisper => &["ggml", OPENVINO_IR],
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
/// optionally pinned to the commit `revision`), and so are the files' sizes
/// (`super::sizes`).
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
    pub license: License,
    pub repo: String,
    #[serde(default)]
    pub revision: Option<String>,
    pub files: Vec<CatalogFile>,
    #[serde(default)]
    pub min_app_version: Option<String>,
    #[serde(default)]
    pub params: Option<LlamaParams>,
    /// An `openvino-ir` entry: the ids of the ggml Whisper models it runs in
    /// place of. Older apps ignore the field and hide the entry for its format.
    #[serde(default)]
    pub companion_of: Vec<String>,
    /// An `openvino-ir` entry: the id of the runtime (`Catalog::runtimes`)
    /// that runs it.
    #[serde(default)]
    pub runtime: Option<String>,
}

/// The archive a runtime is taken from: its vendor's own download, pinned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeArchive {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// One file the app takes from a runtime's archive: `name` in the install
/// folder, `path` in the archive, and its pin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeFile {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

/// An inference runtime (#79), in the document's `runtimes` list: libraries
/// the app downloads on each PC from their vendor and loads by absolute path.
/// Unlike a model's, its version and hashes are in the catalog, since the
/// archive comes from a plain download server, not Hugging Face. Apps before
/// 0.5.0 read only `models` and never see these entries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RuntimeEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The vendor's version, `2026.4.1.0`; also the install folder's name.
    pub version: String,
    /// `windows-x86_64`: the build that may load it ([`platform`]).
    pub platform: String,
    /// The level of the runtime's API that the app's binding for `id` calls
    /// (`whisper_engine::openvino::genai::API_LEVEL`). A build installs and
    /// loads only a runtime of its own level, so one catalog can pin a
    /// runtime for each level in use.
    pub api: u32,
    pub license: License,
    pub archive: RuntimeArchive,
    pub files: Vec<RuntimeFile>,
    #[serde(default)]
    pub min_app_version: Option<String>,
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

/// A full Git commit id as Hugging Face writes it: 40 lowercase hex digits.
pub fn is_commit(value: &str) -> bool {
    COMMIT.is_match(value)
}

/// A SHA-256 as Hugging Face's listing (`lfs.oid`) and install records
/// write it: 64 lowercase hex digits.
pub fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

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
        if !is_text(&self.license.name, 80) || !self.license.url.starts_with("https://") {
            problems.push("license needs a name and an https url".to_string());
        }
        if !REPO.is_match(&self.repo) {
            problems.push("repo must be a Hugging Face repository, owner/name".to_string());
        }
        if self.revision.as_deref().is_some_and(|revision| !is_commit(revision)) {
            problems.push("revision must be a full 40-character commit id".to_string());
        }
        if self.min_app_version.as_deref().is_some_and(|version| !VERSION.is_match(version)) {
            problems.push("min_app_version must be X.Y.Z".to_string());
        }
        problems.extend(self.file_problems());
        problems.extend(self.companion_problems());
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
            Engine::Whisper if self.format == OPENVINO_IR => {
                if self.files.len() != OPENVINO_WHISPER_FILES.len()
                    || !OPENVINO_WHISPER_FILES.iter().all(|name| names.contains(name))
                {
                    problems.push(format!("an openvino-ir model is the files {}", OPENVINO_WHISPER_FILES.join(", ")));
                }
            }
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

    /// An `openvino-ir` entry names the models it serves, the runtime that
    /// runs it and a pinned commit: GenAI reads an IR export only as far as
    /// the runtime understands it, so a new commit comes with a runtime it
    /// was measured on.
    fn companion_problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        if self.format == OPENVINO_IR {
            if self.companion_of.is_empty() || !self.companion_of.iter().all(|id| ID.is_match(id)) {
                problems.push("companion_of must list the ids of the whisper models it serves".to_string());
            }
            if self.revision.is_none() {
                problems.push("an openvino-ir model needs a pinned revision".to_string());
            }
            if !self.runtime.as_deref().is_some_and(|runtime| RUNTIMES.iter().any(|(id, ..)| *id == runtime)) {
                let known: Vec<&str> = RUNTIMES.iter().map(|(id, ..)| *id).collect();
                problems.push(format!("runtime must name the runtime that runs it: {}", known.join(", ")));
            }
        } else {
            if !self.companion_of.is_empty() {
                problems.push("companion_of is only used by openvino-ir models".to_string());
            }
            if self.runtime.is_some() {
                problems.push("runtime is only used by openvino-ir models".to_string());
            }
        }
        problems
    }

    /// Whether this is an OpenVINO companion rather than a model of its own.
    pub fn is_companion(&self) -> bool {
        self.engine == Engine::Whisper && self.format == OPENVINO_IR
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

static RUNTIME_VERSION: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d+\.\d+\.\d+(\.\d+)?$").unwrap());
static ZIP_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r"^https://[^/?#]+/[^?#]*\.zip$").unwrap());

/// Byte sizes as check-catalog.mjs can hold them: 1 to 2^53 - 1.
fn is_size(size: u64) -> bool {
    (1..=(1u64 << 53) - 1).contains(&size)
}

impl RuntimeEntry {
    /// The rules serde does not check, as sentences; empty when the entry can
    /// be used. Mirrors `runtimeProblems` in check-catalog.mjs.
    pub fn problems(&self) -> Vec<String> {
        let mut problems = Vec::new();
        match RUNTIMES.iter().find(|(id, ..)| *id == self.id) {
            None => problems.push(format!("runtime {:?} is not supported", self.id)),
            Some((_, platforms, _)) if !platforms.contains(&self.platform.as_str()) => {
                problems.push(format!("platform {:?} is not supported by {}", self.platform, self.id));
            }
            Some(_) => {}
        }
        if !is_text(&self.name, 80) {
            problems.push("name must be a non-empty text of at most 80 characters".to_string());
        }
        if self.description.chars().count() > 300 {
            problems.push("description must be a text of at most 300 characters".to_string());
        }
        if !RUNTIME_VERSION.is_match(&self.version) {
            problems.push("version must be X.Y.Z or X.Y.Z.W".to_string());
        }
        if self.api == 0 {
            problems.push("api must be a whole number from 1".to_string());
        }
        if !is_text(&self.license.name, 80) || !self.license.url.starts_with("https://") {
            problems.push("license needs a name and an https url".to_string());
        }
        let archive = &self.archive;
        if !ZIP_URL.is_match(&archive.url) || !is_size(archive.size) || !is_sha256(&archive.sha256) {
            problems.push("archive needs the https url of a .zip, its size and its sha256".to_string());
        }
        if self.min_app_version.as_deref().is_some_and(|version| !VERSION.is_match(version)) {
            problems.push("min_app_version must be X.Y.Z".to_string());
        }
        if self.files.is_empty() {
            problems.push("files must list at least one file".to_string());
            return problems;
        }
        let mut names = HashSet::new();
        for file in &self.files {
            if !FILE_NAME.is_match(&file.name) || !is_repo_path(&file.path) || !is_size(file.size) || !is_sha256(&file.sha256) {
                problems.push("every file needs a safe name, its path in the archive, its size and its sha256".to_string());
                continue;
            }
            if !names.insert(file.name.as_str()) {
                problems.push(format!("file {} is listed twice", file.name));
            }
        }
        let required = RUNTIMES.iter().find(|(id, ..)| *id == self.id).map_or(&[][..], |(_, _, files)| *files);
        let missing: Vec<&str> = required.iter().copied().filter(|name| !names.contains(name)).collect();
        if !missing.is_empty() {
            problems.push(format!("{} needs the files {}", self.id, missing.join(", ")));
        }
        problems
    }

    /// Whether this build may install and load the runtime: it is for this
    /// platform, of the API level `api` this build's binding calls, and its
    /// `min_app_version` is not above `app_version`.
    pub fn runs_on(&self, app_version: &str, api: u32) -> bool {
        self.platform == platform()
            && self.api == api
            && self.min_app_version.as_deref().map_or(true, |minimum| version_triple(app_version) >= version_triple(minimum))
    }

    /// The bytes the files take once installed.
    pub fn installed_size(&self) -> u64 {
        self.files.iter().map(|file| file.size).sum()
    }
}

/// A runtime version as numbers for ordering: `2026.4.1.0` → [2026, 4, 1, 0].
pub fn runtime_version_key(version: &str) -> Vec<u64> {
    version.split('.').map(|part| part.parse().unwrap_or(0)).collect()
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

/// A readable catalog: the usable entries in file order and the hidden ones,
/// and the same for the runtimes (`hidden_runtimes` indexes `runtimes` in
/// the document).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Catalog {
    pub entries: Vec<Entry>,
    pub hidden: Vec<Hidden>,
    pub runtimes: Vec<RuntimeEntry>,
    pub hidden_runtimes: Vec<Hidden>,
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
    parse_runtimes(object.get("runtimes"), &mut catalog);
    Ok(catalog)
}

/// Reads the document's `runtimes` (optional): a broken list or entry hides
/// runtimes only, never models. Of two entries with the same id, platform
/// and API level the first is kept.
fn parse_runtimes(runtimes: Option<&serde_json::Value>, catalog: &mut Catalog) {
    let list = match runtimes {
        None => return,
        Some(serde_json::Value::Array(list)) => list,
        Some(_) => {
            catalog.hidden_runtimes.push(Hidden { index: 0, id: None, problem: "runtimes must be a list".to_string() });
            return;
        }
    };
    let mut keys = HashSet::new();
    for (index, value) in list.iter().enumerate() {
        let id = value.get("id").and_then(|id| id.as_str()).map(str::to_string);
        let hide = |problem: String| Hidden { index, id: id.clone(), problem };
        let runtime = match serde_json::from_value::<RuntimeEntry>(value.clone()) {
            Ok(runtime) => runtime,
            Err(error) => {
                catalog.hidden_runtimes.push(hide(error.to_string()));
                continue;
            }
        };
        let problems = runtime.problems();
        if !problems.is_empty() {
            catalog.hidden_runtimes.extend(problems.into_iter().map(hide));
            continue;
        }
        if !keys.insert((runtime.id.clone(), runtime.platform.clone(), runtime.api)) {
            catalog.hidden_runtimes.push(hide(format!("{}/{}/api {} is listed twice", runtime.id, runtime.platform, runtime.api)));
            continue;
        }
        catalog.runtimes.push(runtime);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../../../scripts/model-catalog/test/entry-cases.json");

    /// The base entry with the case's dotted paths set and removed, as in
    /// check-catalog.test.mjs.
    fn case_entry(cases: &Value, case: &Value) -> Value {
        case_entry_from(&cases["bases"], case)
    }

    fn case_entry_from(bases: &Value, case: &Value) -> Value {
        let mut entry = bases[case["base"].as_str().unwrap()].clone();
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
    fn the_shared_runtime_cases_agree_with_the_pull_request_check() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        for case in cases["runtime_cases"].as_array().unwrap() {
            let runtime = case_entry_from(&cases["runtime_bases"], case);
            let document = serde_json::json!({ "schema": 1, "models": [], "runtimes": [runtime] });
            let catalog = parse(document.to_string().as_bytes()).unwrap();
            let valid = catalog.hidden_runtimes.is_empty();
            assert_eq!(valid, case["valid"].as_bool().unwrap(), "{}: {:?}", case["name"], catalog.hidden_runtimes);
            assert_eq!(catalog.runtimes.len(), usize::from(valid));
        }
    }

    #[test]
    fn runtimes_are_hidden_on_their_own_and_never_take_models_with_them() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let whisper = cases["bases"]["whisper"].clone();
        let runtime = cases["runtime_bases"]["openvino"].clone();
        let mut twin = runtime.clone();
        twin["version"] = Value::from("2026.5.0.0");
        let mut later = runtime.clone();
        later["api"] = Value::from(2);
        let document = serde_json::json!({ "schema": 1, "models": [whisper], "runtimes": [runtime, twin, later, 7] });
        let catalog = parse(document.to_string().as_bytes()).unwrap();
        assert_eq!(catalog.entries.len(), 1);
        assert_eq!(catalog.runtimes.iter().map(|runtime| runtime.api).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(catalog.hidden_runtimes.iter().map(|hidden| hidden.index).collect::<Vec<_>>(), [1, 3]);
        assert!(catalog.hidden_runtimes[0].problem.contains("api 1 is listed twice"));

        let document = serde_json::json!({ "schema": 1, "models": [cases["bases"]["whisper"].clone()], "runtimes": {} });
        let catalog = parse(document.to_string().as_bytes()).unwrap();
        assert_eq!((catalog.entries.len(), catalog.runtimes.len()), (1, 0));
        assert_eq!(catalog.hidden_runtimes[0].problem, "runtimes must be a list");
    }

    #[test]
    fn a_runtime_runs_only_on_its_platform_api_level_and_app_versions() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let mut runtime: RuntimeEntry = serde_json::from_value(cases["runtime_bases"]["openvino"].clone()).unwrap();
        runtime.platform = platform().to_string();
        assert!(runtime.runs_on("0.5.0", 1));
        assert!(!runtime.runs_on("0.5.0", 2));
        runtime.min_app_version = Some("0.6.0".to_string());
        assert!(!runtime.runs_on("0.5.0", 1));
        assert!(runtime.runs_on("0.6.0", 1));
        runtime.platform = "elsewhere-x86_64".to_string();
        assert!(!runtime.runs_on("0.6.0", 1));
        assert!(runtime_version_key("2026.10.0.0") > runtime_version_key("2026.4.1.0"));
        assert!(runtime_version_key("2026.4.1.1") > runtime_version_key("2026.4.1"));
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
    fn commits_and_hashes_are_lowercase_hex_of_their_length() {
        assert!(is_commit(&"0a".repeat(20)));
        assert!(!is_commit(&"0A".repeat(20)));
        assert!(!is_commit(&"0a".repeat(21)));
        assert!(is_sha256(&"f9".repeat(32)));
        assert!(!is_sha256(&"F9".repeat(32)));
        assert!(!is_sha256(&"g9".repeat(32)));
        assert!(!is_sha256(&"f9".repeat(20)));
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
