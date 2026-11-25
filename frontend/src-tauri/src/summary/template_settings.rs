//! What Settings › Summary templates needs beyond the upstream template
//! commands (Protocol): one template whole, for its sections and the editor,
//! and the stored default template.
//!
//! The default is the template a run gets when it names none: the automatic
//! summary after a recording, and any other caller that leaves `template_id`
//! out of `api_process_transcript`. Upstream fell back to `daily_standup`
//! there while its UI always sent `standard_meeting`; now the user picks it.

use super::templates::{self, Template};
use std::path::{Path, PathBuf};

/// The template used while none is stored, or when the stored one no longer
/// loads (a custom template deleted after it was chosen). It is the one the
/// UI always sent before a default could be stored.
pub const FALLBACK_TEMPLATE_ID: &str = "standard_meeting";

/// Next to the other app-managed settings files; a bare id, one line.
fn default_path() -> PathBuf {
    crate::paths::install_data_root().join("default_summary_template.txt")
}

fn read_stored(file: &Path) -> Option<String> {
    let stored = std::fs::read_to_string(file).ok()?;
    let id = stored.trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// An id the WebView or the stored file hands in, accepted only in the
/// charset `save_custom_template` writes (ASCII letters, digits, `_`, `-`,
/// as its `sanitize_template_id`). `get_template` joins the id into a path
/// in the custom templates folder, so `../x` would read a `.json` outside it
/// and, stored as the default, feed it to every run without a template.
fn checked_id(id: &str) -> Result<&str, String> {
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    valid
        .then_some(id)
        .ok_or_else(|| format!("Not a template id: {id}"))
}

/// The stored id while that template still loads, else the fallback.
fn resolve(stored: Option<String>) -> String {
    match stored {
        Some(id) if checked_id(&id).is_ok() && templates::get_template(&id).is_ok() => id,
        _ => FALLBACK_TEMPLATE_ID.to_string(),
    }
}

/// The template a summary uses when none is asked for.
pub fn default_template_id() -> String {
    resolve(read_stored(&default_path()))
}

/// One template whole: name, description and sections, from the custom,
/// bundled or built-in copy, the same one a summary would use.
#[tauri::command]
pub async fn api_get_template(template_id: String) -> Result<Template, String> {
    templates::get_template(checked_id(&template_id)?)
}

/// The default template's id; the fallback when none is stored or the stored
/// one is gone, so the answer always names a template that loads.
#[tauri::command]
pub async fn api_get_default_template() -> Result<String, String> {
    Ok(default_template_id())
}

/// Stores the default template. Only a template that loads can be stored.
#[tauri::command]
pub async fn api_set_default_template(template_id: String) -> Result<(), String> {
    templates::get_template(checked_id(&template_id)?)?;
    std::fs::write(default_path(), &template_id)
        .map_err(|error| format!("Failed to save the default template: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_stored_uses_the_fallback() {
        assert_eq!(resolve(None), FALLBACK_TEMPLATE_ID);
    }

    #[test]
    fn an_id_that_leaves_the_templates_folder_is_refused() {
        for id in ["../x", "..\\x", "a/b", "", "standard meeting"] {
            assert!(checked_id(id).is_err(), "{id:?} should be refused");
        }
        assert_eq!(checked_id("my-template_2"), Ok("my-template_2"));
        assert_eq!(
            resolve(Some("../../somewhere/file".to_string())),
            FALLBACK_TEMPLATE_ID
        );
        let refused = tauri::async_runtime::block_on(api_set_default_template(
            "../../somewhere/file".to_string(),
        ));
        assert!(refused.is_err());
    }

    #[test]
    fn a_stored_template_that_loads_is_the_default() {
        assert_eq!(resolve(Some("daily_standup".to_string())), "daily_standup");
    }

    #[test]
    fn a_stored_template_that_is_gone_falls_back() {
        assert_eq!(
            resolve(Some("deleted_custom_template".to_string())),
            FALLBACK_TEMPLATE_ID
        );
    }

    #[test]
    fn the_fallback_is_a_built_in_template() {
        assert!(templates::get_template(FALLBACK_TEMPLATE_ID).is_ok());
    }

    #[test]
    fn reads_the_stored_id() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("default_summary_template.txt");
        assert_eq!(read_stored(&file), None);

        std::fs::write(&file, "daily_standup\n").unwrap();

        assert_eq!(read_stored(&file).as_deref(), Some("daily_standup"));
    }

    #[test]
    fn a_blank_file_stores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("default_summary_template.txt");
        std::fs::write(&file, " \n").unwrap();
        assert_eq!(read_stored(&file), None);
    }
}
