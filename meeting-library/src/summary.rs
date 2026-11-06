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

/// The complete summary as markdown, as the app's Markdown export renders it
/// (`completeSummaryMarkdown(parseSummaryData(...))` in
/// `frontend/src/lib/summary-markdown.ts`). A top-level BlockNote array, which
/// the export leaves empty, is rendered like `summary_json`.
pub fn summary_markdown(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let value = match serde_json::from_str::<Value>(raw) {
        Ok(value) => value,
        Err(_) => return Some(raw.to_string()),
    };
    let markdown = match &value {
        // Double-encoded: a JSON string that holds the summary JSON, or
        // markdown saved as a JSON string.
        Value::String(inner) => match serde_json::from_str::<Value>(inner) {
            Ok(parsed @ (Value::Object(_) | Value::Array(_))) => complete_markdown(&parsed),
            _ => inner.clone(),
        },
        other => complete_markdown(other),
    };
    let markdown = markdown.trim();
    (!markdown.is_empty()).then(|| markdown.to_string())
}

fn complete_markdown(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks_to_markdown(blocks),
        Value::Object(object) => {
            if let Some(markdown) = object.get("markdown").and_then(Value::as_str) {
                return markdown.to_string();
            }
            if let Some(blocks) = object.get("summary_json").and_then(Value::as_array) {
                return blocks_to_markdown(blocks);
            }
            let mut keys: Vec<&str> = Vec::new();
            let ordered = object
                .get("_section_order")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str);
            for key in ordered.chain(object.keys().map(String::as_str)) {
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            keys.into_iter()
                .filter(|key| !matches!(*key, "english_cache" | "original_markdown"))
                .filter_map(|key| {
                    let section = object.get(key)?;
                    let blocks = section.get("blocks")?.as_array()?;
                    let title = section
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|title| !title.is_empty())
                        .unwrap_or(key);
                    let body = blocks
                        .iter()
                        .map(|block| block.get("content").map(inline_text).unwrap_or_default())
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    Some(format!("## {title}\n\n{body}"))
                })
                .collect::<Vec<_>>()
                .join("\n\n")
        }
        _ => String::new(),
    }
}

/// `blocksToMarkdown` of `summary-markdown.ts`.
fn blocks_to_markdown(blocks: &[Value]) -> String {
    fn walk(list: &[Value], depth: usize, out: &mut Vec<String>) {
        for block in list {
            let text = block
                .get("content")
                .map(inline_text)
                .unwrap_or_default()
                .trim()
                .to_string();
            let indent = "  ".repeat(depth);
            let props = block.get("props");
            match block.get("type").and_then(Value::as_str) {
                Some("heading") => {
                    let level = props
                        .and_then(|props| props.get("level"))
                        .and_then(Value::as_i64)
                        .unwrap_or(2)
                        .clamp(1, 6) as usize;
                    out.push(format!("{} {}", "#".repeat(level), text));
                }
                Some("bulletListItem") => out.push(format!("{indent}- {text}")),
                Some("numberedListItem") => out.push(format!("{indent}1. {text}")),
                Some("checkListItem") => {
                    let checked = props
                        .and_then(|props| props.get("checked"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    out.push(format!("{indent}- [{}] {text}", if checked { 'x' } else { ' ' }));
                }
                Some("quote") => {
                    if !text.is_empty() {
                        out.push(format!("> {text}"));
                    }
                }
                Some("table") => table_lines(block, out),
                _ => {
                    if !text.is_empty() {
                        out.push(text);
                    }
                }
            }
            if let Some(children) = block.get("children").and_then(Value::as_array) {
                if !children.is_empty() {
                    walk(children, depth + 1, out);
                }
            }
        }
    }

    let mut out = Vec::new();
    walk(blocks, 0, &mut out);
    out.join("\n")
}

fn table_lines(block: &Value, out: &mut Vec<String>) {
    let Some(rows) = block
        .get("content")
        .and_then(|content| content.get("rows"))
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty())
    else {
        return;
    };
    let cells: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            row.get("cells")
                .and_then(Value::as_array)
                .map(|cells| {
                    cells
                        .iter()
                        .map(|cell| {
                            let content = if cell.is_array() { Some(cell) } else { cell.get("content") };
                            content
                                .map(inline_text)
                                .unwrap_or_default()
                                .trim()
                                .replace('|', "\\|")
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();
    let width = cells.iter().map(Vec::len).max().unwrap_or(0).max(1);
    let line = |row: &[String]| {
        let padded: Vec<&str> = (0..width)
            .map(|index| row.get(index).map(String::as_str).unwrap_or(""))
            .collect();
        format!("| {} |", padded.join(" | "))
    };
    out.push(line(&cells[0]));
    out.push(format!("| {} |", vec!["---"; width].join(" | ")));
    for row in &cells[1..] {
        out.push(line(row));
    }
}

#[cfg(test)]
mod tests {
    use super::{summary_markdown, visible_summary_text};

    #[test]
    fn markdown_summaries_are_returned_as_written() {
        assert_eq!(
            summary_markdown(r###"{"markdown":"## Decisions\n- Ship it","english_cache":{"markdown":"cache"}}"###)
                .as_deref(),
            Some("## Decisions\n- Ship it")
        );
        assert_eq!(summary_markdown("Plain **markdown**").as_deref(), Some("Plain **markdown**"));
        let double = serde_json::to_string(r#"{"markdown":"Twice encoded"}"#).unwrap();
        assert_eq!(summary_markdown(&double).as_deref(), Some("Twice encoded"));
        assert_eq!(summary_markdown("\"Markdown in a JSON string\"").as_deref(), Some("Markdown in a JSON string"));
        assert_eq!(summary_markdown("  "), None);
        assert_eq!(summary_markdown(r#"{"english_cache":{"markdown":"only a cache"}}"#), None);
    }

    #[test]
    fn blocknote_summaries_become_markdown_like_the_export() {
        let raw = r#"{"summary_json":[
            {"type":"heading","props":{"level":1},"content":[{"type":"text","text":"Итоги"}]},
            {"type":"paragraph","content":[{"text":"Intro "},{"text":"text"}]},
            {"type":"bulletListItem","content":"First","children":[
                {"type":"bulletListItem","content":[{"text":"Nested"}]}
            ]},
            {"type":"numberedListItem","content":[{"text":"Step"}]},
            {"type":"checkListItem","props":{"checked":true},"content":[{"text":"Done"}]},
            {"type":"checkListItem","content":[{"text":"Open"}]},
            {"type":"quote","content":[{"text":"Said"}]},
            {"type":"quote","content":[]},
            {"type":"table","content":{"rows":[
                {"cells":[[{"text":"Who"}],[{"text":"What"}]]},
                {"cells":[{"content":[{"text":"Alice"}]},[{"text":"a|b"}]]}
            ]}},
            {"type":"heading","content":[{"text":"Default level"}]}
        ]}"#;
        assert_eq!(
            summary_markdown(raw).unwrap(),
            "# Итоги\nIntro text\n- First\n  - Nested\n1. Step\n- [x] Done\n- [ ] Open\n> Said\n\
             | Who | What |\n| --- | --- |\n| Alice | a\\|b |\n## Default level"
        );
    }

    #[test]
    fn legacy_section_summaries_follow_their_section_order() {
        let raw = r#"{
            "MeetingName":"Weekly",
            "_section_order":["decisions","actions"],
            "actions":{"title":"Action Items","blocks":[{"content":"Call Alice"},{"content":[{"text":"Email Bob"}]}]},
            "decisions":{"title":"","blocks":[{"content":"Ship"}]},
            "english_cache":{"blocks":[{"content":"hidden"}]},
            "original_markdown":{"blocks":[{"content":"hidden"}]}
        }"#;
        assert_eq!(
            summary_markdown(raw).unwrap(),
            "## decisions\n\nShip\n\n## Action Items\n\nCall Alice\n\nEmail Bob"
        );
    }

    #[test]
    fn visible_text_skips_caches() {
        assert_eq!(
            visible_summary_text(r#"{"markdown":"Visible","english_cache":{"markdown":"Hidden"}}"#).as_deref(),
            Some("Visible")
        );
        assert_eq!(visible_summary_text("{not json"), None);
    }
}
