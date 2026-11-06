//! The text of a saved summary (`summary_processes.result`). Summaries are
//! stored as markdown, as BlockNote JSON, or (older meetings) as a map of
//! titled sections, possibly JSON-encoded twice, next to caches that are not
//! part of the visible summary (`english_cache`).

use serde_json::Value;

/// The summary's visible text, flattened to lines, for search and AI context.
/// Raw JSON that is neither a summary nor plain text gives `None`.
pub fn visible_summary_text(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(value) => visible_summary_value(&value),
        Err(_) if raw.starts_with('{') || raw.starts_with('[') => None,
        Err(_) => Some(raw.to_string()),
    }
}

fn visible_summary_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let text = text.trim();
            if text.starts_with('{') || text.starts_with('[') {
                visible_summary_text(text)
            } else {
                (!text.is_empty()).then(|| text.to_string())
            }
        }
        Value::Array(blocks) => blocknote_text(blocks),
        Value::Object(object) => {
            if let Some(markdown) = object
                .get("markdown")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
            {
                return Some(markdown.to_string());
            }
            if let Some(blocks) = object.get("summary_json").and_then(Value::as_array) {
                if let Some(text) = blocknote_text(blocks) {
                    return Some(text);
                }
            }

            let mut sections = Vec::new();
            let ordered_keys: Vec<&str> = object
                .get("_section_order")
                .and_then(Value::as_array)
                .map(|keys| keys.iter().filter_map(Value::as_str).collect())
                .unwrap_or_else(|| object.keys().map(String::as_str).collect());
            for key in ordered_keys {
                if matches!(
                    key,
                    "markdown" | "summary_json" | "_section_order" | "MeetingName" | "english_cache"
                ) {
                    continue;
                }
                let Some(section) = object.get(key).and_then(Value::as_object) else {
                    continue;
                };
                let Some(blocks) = section.get("blocks").and_then(Value::as_array) else {
                    continue;
                };
                if let Some(title) = section
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|title| !title.is_empty())
                {
                    sections.push(title.to_string());
                }
                for block in blocks {
                    let text = inline_text(block).trim().to_string();
                    if !text.is_empty() {
                        sections.push(text);
                    }
                }
            }
            (!sections.is_empty()).then(|| sections.join("\n"))
        }
        _ => None,
    }
}

fn blocknote_text(blocks: &[Value]) -> Option<String> {
    fn walk(blocks: &[Value], output: &mut Vec<String>) {
        for block in blocks {
            let text = block
                .get("content")
                .map(inline_text)
                .unwrap_or_default()
                .trim()
                .to_string();
            if !text.is_empty() {
                output.push(text);
            }
            if let Some(children) = block.get("children").and_then(Value::as_array) {
                walk(children, output);
            }
        }
    }

    let mut output = Vec::new();
    walk(blocks, &mut output);
    (!output.is_empty()).then(|| output.join("\n"))
}

fn inline_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values.iter().map(inline_text).collect(),
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                text.to_string()
            } else {
                object.get("content").map(inline_text).unwrap_or_default()
            }
        }
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::visible_summary_text;

    #[test]
    fn visible_text_skips_caches() {
        assert_eq!(
            visible_summary_text(r#"{"markdown":"Visible","english_cache":{"markdown":"Hidden"}}"#).as_deref(),
            Some("Visible")
        );
        assert_eq!(visible_summary_text("{not json"), None);
    }
}
