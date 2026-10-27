//! The list of transcription and summary models the app offers (#50).
//!
//! The list is `model-catalog/catalog.json` on this repository's `main`
//! branch, changed by pull requests without an app release. Every build
//! embeds the copy it was built with, for the first start, offline use and as
//! the fallback. An entry names a Hugging Face repository and files, never a
//! version: the commit and each file's size and SHA-256 are resolved from
//! Hugging Face when a model is downloaded or checked for updates (see
//! `huggingface.rs`). Diarization models are not in the catalog; they ship
//! with the app and stay pinned in `crate::model_integrity`.
//!
//! Ownership: this module owns which catalog is in use. Engines ask it for
//! entries every time they list or download, so a refreshed catalog applies
//! without a restart.

pub mod huggingface;
pub mod installed;
pub mod schema;
#[cfg(test)]
pub(crate) mod testing;

use once_cell::sync::Lazy;
use schema::{Catalog, Engine, Entry};
use std::sync::{Arc, RwLock};

/// The catalog this build was made with.
const BUILT_IN: &str = include_str!("../../../../model-catalog/catalog.json");

static BUILT_IN_CATALOG: Lazy<Arc<Catalog>> = Lazy::new(|| match schema::parse(BUILT_IN.as_bytes()) {
    Ok(catalog) => {
        for hidden in &catalog.hidden {
            log::error!("[model catalog] built-in entry {} hidden: {}", hidden.index, hidden.problem);
        }
        Arc::new(catalog)
    }
    // Tests keep this from happening; a build without models still starts.
    Err(error) => {
        log::error!("[model catalog] the built-in catalog cannot be read: {error}");
        Arc::new(Catalog::default())
    }
});

/// The catalog in use.
static ACTIVE: Lazy<RwLock<Arc<Catalog>>> = Lazy::new(|| RwLock::new(BUILT_IN_CATALOG.clone()));

/// The version entries are compared with (`min_app_version`).
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn built_in() -> Arc<Catalog> {
    BUILT_IN_CATALOG.clone()
}

pub fn active() -> Arc<Catalog> {
    ACTIVE.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
}

/// The entries of `engine` this build can run, in catalog order, including
/// unlisted ones (an installed copy of those keeps working).
pub fn entries(engine: Engine) -> Vec<Entry> {
    usable(&active(), engine).cloned().collect()
}

/// [`entries`], plus built-in entries that the catalog in use no longer has
/// but whose model `is_installed`: removing an entry from `main` must not take
/// a model away from people who have it.
pub fn entries_with_installed(engine: Engine, is_installed: impl Fn(&Entry) -> bool) -> Vec<Entry> {
    let mut entries = entries(engine);
    let built_in = built_in();
    let missing: Vec<Entry> = usable(&built_in, engine)
        .filter(|entry| !entries.iter().any(|known| known.id == entry.id))
        .filter(|entry| is_installed(entry))
        .cloned()
        .collect();
    entries.extend(missing);
    entries
}

/// What an engine lists in Settings: the listed entries, and unlisted or
/// dropped ones whose model `is_installed`.
pub fn offered(engine: Engine, is_installed: impl Fn(&Entry) -> bool) -> Vec<Entry> {
    entries_with_installed(engine, &is_installed)
        .into_iter()
        .filter(|entry| entry.listed || is_installed(entry))
        .collect()
}

/// The entry `id` of `engine`, from the catalog in use or else the built-in one.
pub fn entry(engine: Engine, id: &str) -> Option<Entry> {
    let find = |catalog: &Catalog| usable(catalog, engine).find(|entry| entry.id == id).cloned();
    find(&active()).or_else(|| find(&built_in()))
}

fn usable(catalog: &Catalog, engine: Engine) -> impl Iterator<Item = &Entry> {
    catalog
        .entries
        .iter()
        .filter(move |entry| entry.engine == engine && entry.runs_on(app_version()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_catalog_is_valid_and_complete() {
        let catalog = schema::parse(BUILT_IN.as_bytes()).expect("built-in catalog");
        assert!(catalog.hidden.is_empty(), "{:?}", catalog.hidden);
        // Ids the code still names: defaults, fallbacks and the optional model.
        for (engine, id) in [
            (Engine::Whisper, crate::config::DEFAULT_WHISPER_MODEL),
            (Engine::Whisper, "small"),
            (Engine::Whisper, "large-v3-turbo-q5_0"),
            (Engine::Parakeet, crate::config::DEFAULT_PARAKEET_MODEL),
            (Engine::Llama, "qwen3.5:2b"),
            (Engine::Llama, "qwen3.5:4b"),
        ] {
            assert!(
                catalog.entries.iter().any(|entry| entry.engine == engine && entry.id == id),
                "{} {id} is missing",
                engine.as_str()
            );
        }
        assert!(catalog.entries.iter().all(|entry| entry.runs_on(app_version())));
    }

    #[test]
    fn entries_follow_the_catalog_in_use_and_keep_installed_built_in_models() {
        let mut replacement = (*built_in()).clone();
        replacement.entries.retain(|entry| entry.id != "tiny");
        let _restore = testing::use_catalog(replacement);
        assert!(!entries(Engine::Whisper).iter().any(|entry| entry.id == "tiny"));
        // Still found for an installed copy, and by id.
        let with_installed = entries_with_installed(Engine::Whisper, |entry| entry.id == "tiny");
        assert!(with_installed.iter().any(|entry| entry.id == "tiny"));
        assert!(!entries_with_installed(Engine::Whisper, |_| false).iter().any(|entry| entry.id == "tiny"));
        assert_eq!(entry(Engine::Whisper, "tiny").unwrap().files[0].name, "ggml-tiny.bin");
    }

    #[test]
    fn entries_for_a_newer_app_are_left_out() {
        let mut replacement = (*built_in()).clone();
        for entry in &mut replacement.entries {
            if entry.id == "base" {
                entry.min_app_version = Some("99.0.0".to_string());
            }
        }
        let _restore = testing::use_catalog(replacement);
        assert!(!entries(Engine::Whisper).iter().any(|entry| entry.id == "base"));
        // The built-in copy, made for this build, still answers by id.
        assert!(entry(Engine::Whisper, "base").is_some());
    }
}
