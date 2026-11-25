//! Puts action items back into the summaries they were taken from (#218).
//!
//! Versions up to 1.0.0-rc.1 moved a summary's action section into
//! `action_items` rows (owner, due text, done mark) and saved the summary
//! without it, keeping the untrimmed text as `original_markdown`; the meeting's
//! `action_items_source` recorded the summary text that was read. Protocol no
//! longer keeps items apart: the summary lists them as the model wrote them.
//!
//! `restore_action_sections` runs once per launch, after the migrations, and
//! is idempotent: a meeting it finishes gets `action_items_source =
//! RESTORED_MARKER` in the same transaction as its summary, so the next
//! launch skips it. A data step in Rust rather than a migration, because the
//! summary is JSON holding Markdown, and finding an action section needs the
//! same heading rules the UI used to move it (`ACTION_HEADING`). A failed
//! meeting is logged and left unmarked, so a later launch tries again.
//!
//! The `action_items` table stays as it is (released migrations never
//! change); nothing reads or writes its rows for display any more, except
//! contact merges and deletions that keep their owner links consistent.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use sqlx::SqlitePool;
use tracing::{info, warn};

/// `action_items_source` of a meeting whose summary has its items back. Not a
/// fingerprint the old UI could write, so an older build that opens this
/// database sees the meeting as read and does not move the section out again.
pub const RESTORED_MARKER: &str = "restored-to-summary";

/// The section heading a summary gets when it is rebuilt from rows alone.
const RENDERED_HEADING: &str = "## Action Items";

/// The headings the old UI recognised as an action section
/// (`162e8be…/actionItemText.ts`, `ACTION_HEADING_RE`), matched after
/// `normalize_heading`.
static ACTION_HEADING: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(?:key |open |proposed |agreed |the )?(?:action items?|actions|action points?|next steps?|to-?dos?|todo list|follow[- ]?ups?|follow[- ]?up items|tasks|assignments|deliverables|commitments)(?:\s*(?:and|&|/)\s*(?:owners?|deadlines?|due dates?|next steps?|follow[- ]?ups?))?$",
    )
    .expect("action heading pattern")
});
static HASH_HEADING: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(#{1,6})\s+(.+?)\s*#*\s*$").expect("heading pattern"));
static BOLD_HEADING: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\*\*(.+?)\*\*:?\s*$").expect("bold heading pattern"));
static ASIDE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\([^)]*\)").expect("aside pattern"));
static NUMBERING: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\s\d.)-]+").expect("numbering pattern"));
static PICTOGRAPH: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\p{Extended_Pictographic}\x{FE0F}]").expect("emoji pattern"));
static TRAILING_COLON: Lazy<Regex> = Lazy::new(|| Regex::new(r"[:：]+\s*$").expect("colon pattern"));
static SPACES: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").expect("space pattern"));

/// A heading for matching: no emphasis, asides, numbering, emoji or colon.
fn normalize_heading(raw: &str) -> String {
    let text = raw.replace("**", "").replace("__", "").replace('`', "");
    let text = ASIDE.replace_all(&text, "");
    let text = NUMBERING.replace(&text, "");
    let text = PICTOGRAPH.replace_all(&text, "");
    let text = TRAILING_COLON.replace(&text, "");
    SPACES.replace_all(&text, " ").trim().to_lowercase()
}

/// A line's heading level and text: 1–6 for `#` headings, 7 for a line that
/// is only bold text (it ends at any `#` heading), as the old UI read them.
fn heading_of(line: &str) -> Option<(usize, String)> {
    let line = line.trim();
    if let Some(found) = HASH_HEADING.captures(line) {
        return Some((found[1].len(), found[2].to_string()));
    }
    BOLD_HEADING.captures(line).map(|found| (7, found[1].to_string()))
}

fn is_action_heading(line: &str) -> bool {
    heading_of(line).is_some_and(|(_, text)| ACTION_HEADING.is_match(&normalize_heading(&text)))
}

/// One action section of a summary: its lines, and the heading line that
/// followed it, which is where it goes back.
#[derive(Debug, Clone, PartialEq)]
struct Section {
    text: String,
    before: Option<String>,
}

/// Every action section with some text under its heading. A section runs from
/// its heading to the next heading at the same or a higher level.
fn action_sections(markdown: &str) -> Vec<Section> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut sections = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let Some((level, _)) = heading_of(lines[index]).filter(|_| is_action_heading(lines[index])) else {
            index += 1;
            continue;
        };
        let mut end = index + 1;
        while end < lines.len() {
            if let Some((next, _)) = heading_of(lines[end]) {
                if next <= level || level == 7 {
                    break;
                }
            }
            end += 1;
        }
        if lines[index + 1..end].iter().any(|line| !line.trim().is_empty()) {
            sections.push(Section {
                text: lines[index..end].join("\n").trim_end().to_string(),
                before: lines.get(end).map(|line| line.trim().to_string()),
            });
        }
        index = end;
    }
    sections
}

/// Puts `section` back before the heading that followed it, or at the end
/// when that heading is gone from `markdown`.
fn insert_section(markdown: &str, section: &Section) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let at = section
        .before
        .as_deref()
        .and_then(|before| lines.iter().position(|line| line.trim() == before));
    match at {
        Some(at) => {
            let head = lines[..at].join("\n");
            let tail = lines[at..].join("\n");
            let head = head.trim_end();
            if head.is_empty() {
                format!("{}\n\n{}", section.text, tail)
            } else {
                format!("{head}\n\n{}\n\n{tail}", section.text)
            }
        }
        None if markdown.trim().is_empty() => section.text.clone(),
        None => format!("{}\n\n{}", markdown.trim_end(), section.text),
    }
}

/// An `action_items` row as the restore reads it.
#[derive(Debug, Clone, sqlx::FromRow)]
struct ActionRow {
    text: String,
    owner_label: Option<String>,
    due_text: Option<String>,
    done: bool,
    source: String,
    edited: bool,
}

impl ActionRow {
    /// A row the user added or changed, which the summary text cannot hold.
    fn is_users(&self) -> bool {
        self.source == "user" || self.edited
    }

    /// "- Priya Shah: Send the terms (due Friday, done)".
    fn render(&self) -> String {
        let text = SPACES.replace_all(self.text.trim(), " ");
        let owner = self.owner_label.as_deref().map(str::trim).filter(|owner| !owner.is_empty());
        let mut notes = Vec::new();
        if let Some(due) = self.due_text.as_deref().map(str::trim).filter(|due| !due.is_empty()) {
            notes.push(format!("due {due}"));
        }
        if self.done {
            notes.push("done".to_string());
        }
        let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) };
        match owner {
            Some(owner) => format!("- {owner}: {text}{notes}"),
            None => format!("- {text}{notes}"),
        }
    }
}

/// Text for "does the summary already say this": no emphasis, one space, lower case.
fn comparable(text: &str) -> String {
    SPACES.replace_all(&text.replace("**", "").replace("__", "").replace('`', ""), " ").trim().to_lowercase()
}

/// Which rows to write into the summary besides what its text already says.
#[derive(Debug, Clone, Copy, PartialEq)]
enum RowsToAdd {
    /// The section comes back from `original_markdown`, which holds the
    /// model's items: only the user's own rows can be missing from it.
    UsersOnly,
    /// The summary was read and has no original to take the section from
    /// (edited after the move): every row.
    All,
}

/// The summary `value` with its action items back, or `None` when it needs
/// no change. Only a summary stored as an object with Markdown is changed.
fn restored_summary(value: &Value, rows: &[ActionRow], was_read: bool) -> Option<Value> {
    let object = value.as_object()?;
    let current = object.get("markdown")?.as_str()?;
    if current.lines().any(is_action_heading) {
        // Still there: the move never finished, or the user typed one.
        return None;
    }
    let original = object.get("original_markdown").and_then(Value::as_str);
    let mut sections = original.map(action_sections).unwrap_or_default();
    let wanted = match (was_read, sections.is_empty()) {
        (true, true) => RowsToAdd::All,
        _ => RowsToAdd::UsersOnly,
    };
    let known = comparable(&format!(
        "{current}\n{}",
        sections.iter().map(|section| section.text.as_str()).collect::<Vec<_>>().join("\n")
    ));
    let missing: Vec<String> = rows
        .iter()
        .filter(|row| wanted == RowsToAdd::All || row.is_users())
        .filter(|row| !row.text.trim().is_empty() && !known.contains(&comparable(&row.text)))
        .map(ActionRow::render)
        .collect();
    if !missing.is_empty() {
        match sections.last_mut() {
            Some(section) => {
                // A list straight under a table row reads as one more row to
                // some Markdown readers; a blank line ends the table.
                let gap = if section.text.lines().last().is_some_and(|line| line.trim_start().starts_with('|')) { "\n\n" } else { "\n" };
                section.text = format!("{}{gap}{}", section.text, missing.join("\n"));
            }
            None => sections.push(Section {
                text: format!("{RENDERED_HEADING}\n\n{}", missing.join("\n")),
                // Where the design put the item list: before "Open questions".
                before: current
                    .lines()
                    .find(|line| heading_of(line).is_some_and(|(_, text)| normalize_heading(&text).starts_with("open questions")))
                    .map(|line| line.trim().to_string()),
            }),
        }
    }
    if sections.is_empty() {
        return None;
    }
    let markdown = sections.iter().fold(current.to_string(), |text, section| insert_section(&text, section));
    let mut restored = object.clone();
    restored.insert("markdown".to_string(), Value::String(markdown));
    // The editor shows stored blocks before the Markdown. Blocks without the
    // section would hide it, so the editor rebuilds them from the Markdown.
    restored.remove("summary_json");
    Some(Value::Object(restored))
}

/// Restores every meeting not yet restored. Answers how many summaries changed.
pub async fn restore_action_sections(pool: &SqlitePool) -> Result<usize, sqlx::Error> {
    let meetings: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT m.id, m.action_items_source FROM meetings m \
         WHERE m.action_items_source IS NULL OR m.action_items_source != ?",
    )
    .bind(RESTORED_MARKER)
    .fetch_all(pool)
    .await?;
    let mut changed = 0;
    for (meeting_id, source) in meetings {
        match restore_meeting(pool, &meeting_id, source.is_some()).await {
            Ok(true) => changed += 1,
            Ok(false) => {}
            Err(error) => warn!("Could not put the action items back into the summary of {meeting_id}: {error}"),
        }
    }
    if changed > 0 {
        info!("Put the action items back into {changed} summaries");
    }
    Ok(changed)
}

/// One meeting, in one transaction with its marker. `was_read`: the old UI
/// read this summary for items (`action_items_source` was set). A meeting
/// that was never read and has no rows of the user's has nothing to restore
/// and stays unmarked, so it costs one query per launch.
async fn restore_meeting(pool: &SqlitePool, meeting_id: &str, was_read: bool) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let rows: Vec<ActionRow> = sqlx::query_as(
        "SELECT text, owner_label, due_text, done, source, edited FROM action_items \
         WHERE meeting_id = ? ORDER BY position, created_at",
    )
    .bind(meeting_id)
    .fetch_all(&mut *tx)
    .await?;
    if !was_read && !rows.iter().any(ActionRow::is_users) {
        return Ok(false);
    }
    let result: Option<String> = sqlx::query_scalar("SELECT result FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
    let restored = result
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| restored_summary(&value, &rows, was_read));
    if let Some(summary) = &restored {
        // `user_edited` and `updated_at` stay: the text is what the model and
        // the user wrote, only put back together.
        sqlx::query("UPDATE summary_processes SET result = ? WHERE meeting_id = ?")
            .bind(summary.to_string())
            .bind(meeting_id)
            .execute(&mut *tx)
            .await?;
    } else if result.is_none() && rows.iter().any(ActionRow::is_users) {
        warn!(
            "Meeting {meeting_id} has action items of the user's but no summary to hold them; \
             they stay in the action_items table only"
        );
    }
    sqlx::query("UPDATE meetings SET action_items_source = ? WHERE id = ?")
        .bind(RESTORED_MARKER)
        .bind(meeting_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(restored.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(text: &str, owner: Option<&str>, source: &str, edited: bool) -> ActionRow {
        ActionRow {
            text: text.to_string(),
            owner_label: owner.map(str::to_string),
            due_text: None,
            done: false,
            source: source.to_string(),
            edited,
        }
    }

    const ORIGINAL: &str = "## Summary\n\nWe planned the launch.\n\n## Action Items\n\n| **Owner** | Task | Due |\n| --- | --- | --- |\n| Priya | Send the terms | Friday |\n\n## Open questions\n\n- Pricing?";

    #[test]
    fn recognises_the_headings_the_old_ui_moved() {
        for heading in ["## Action Items", "### 3. Next steps:", "**Action items & owners**", "## ✅ Follow-ups (this week)"] {
            assert!(is_action_heading(heading), "{heading}");
        }
        for heading in ["## Summary", "## Decisions", "Action items were discussed", "## Open questions"] {
            assert!(!is_action_heading(heading), "{heading}");
        }
    }

    #[test]
    fn a_moved_section_comes_back_where_it_was() {
        let moved = json!({"markdown": "## Summary\n\nWe planned the launch.\n\n## Open questions\n\n- Pricing?", "original_markdown": ORIGINAL});
        let restored = restored_summary(&moved, &[row("Send the terms", Some("Priya"), "ai", false)], true).unwrap();
        assert_eq!(restored["markdown"], ORIGINAL);
        assert_eq!(restored["original_markdown"], ORIGINAL, "the original stays as it was");
    }

    #[test]
    fn a_section_that_ended_the_summary_goes_back_at_the_end() {
        let original = "## Summary\n\nShort.\n\n**Next steps**\n- Book the room";
        let moved = json!({"markdown": "## Summary\n\nShort.", "original_markdown": original});
        assert_eq!(restored_summary(&moved, &[], true).unwrap()["markdown"], original);
    }

    #[test]
    fn the_users_own_items_join_the_restored_section() {
        let moved = json!({"markdown": "## Summary\n\nWe planned the launch.\n\n## Open questions\n\n- Pricing?", "original_markdown": ORIGINAL});
        let rows = [
            row("Send the terms", Some("Priya"), "ai", false),
            row("Call the venue", None, "user", false),
            ActionRow { due_text: Some("Monday".into()), done: true, ..row("Draft the FAQ", Some("You"), "ai", true) },
        ];
        let markdown = restored_summary(&moved, &rows, true).unwrap()["markdown"].as_str().unwrap().to_string();
        assert!(
            markdown.contains("| Priya | Send the terms | Friday |\n\n- Call the venue\n- You: Draft the FAQ (due Monday, done)\n\n## Open questions"),
            "{markdown}"
        );
    }

    #[test]
    fn a_summary_edited_after_the_move_gets_its_rows_rendered() {
        let edited = json!({"markdown": "## Summary\n\nEdited by hand.\n\n## Open questions\n\n- Pricing?", "summary_json": [{"type": "paragraph"}]});
        let rows = [row("Send the terms", Some("Priya"), "ai", false), row("Book the room", None, "user", false)];
        let restored = restored_summary(&edited, &rows, true).unwrap();
        assert_eq!(
            restored["markdown"],
            "## Summary\n\nEdited by hand.\n\n## Action Items\n\n- Priya: Send the terms\n- Book the room\n\n## Open questions\n\n- Pricing?"
        );
        assert!(restored.get("summary_json").is_none(), "stale blocks would hide the section");
    }

    #[test]
    fn nothing_changes_when_the_section_is_there_or_there_is_nothing_to_add() {
        let intact = json!({"markdown": ORIGINAL, "original_markdown": ORIGINAL});
        assert_eq!(restored_summary(&intact, &[row("Send the terms", None, "ai", false)], true), None);
        let no_items = json!({"markdown": "## Summary\n\nNothing to do."});
        assert_eq!(restored_summary(&no_items, &[], true), None);
        // A summary the old UI never read keeps its text; only the user's rows are added.
        let unread = json!({"markdown": "## Summary\n\nNew run."});
        assert_eq!(restored_summary(&unread, &[row("Old AI item", None, "ai", false)], false), None);
        assert_eq!(restored_summary(&json!("plain text"), &[row("Call", None, "user", false)], true), None);
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn the_startup_step_restores_once_and_marks_the_meeting() {
        let pool = pool().await;
        let moved = json!({"markdown": "## Summary\n\nWe planned the launch.\n\n## Open questions\n\n- Pricing?", "original_markdown": ORIGINAL});
        sqlx::raw_sql(&format!(
            "INSERT INTO meetings (id, title, created_at, updated_at, action_items_source) VALUES \
                 ('m1', 'Launch', '2026-10-01', '2026-10-01', 'abc-12'), \
                 ('m2', 'Fresh', '2026-10-02', '2026-10-02', NULL); \
             INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result, user_edited) VALUES \
                 ('m1', 'completed', '2026-10-01', '2026-10-01', '{}', 0), \
                 ('m2', 'completed', '2026-10-02', '2026-10-02', '{{\"markdown\":\"## Summary\"}}', 0); \
             INSERT INTO action_items (id, meeting_id, text, owner_label, source, position, created_at, updated_at) VALUES \
                 ('a1', 'm1', 'Send the terms', 'Priya', 'ai', 0, '2026-10-01', '2026-10-01');",
            moved.to_string().replace('\'', "''")
        ))
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(restore_action_sections(&pool).await.unwrap(), 1);
        let (result, edited): (String, bool) =
            sqlx::query_as("SELECT result, user_edited FROM summary_processes WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["markdown"], ORIGINAL);
        assert!(!edited);
        let markers: Vec<Option<String>> = sqlx::query_scalar("SELECT action_items_source FROM meetings ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(markers, [Some(RESTORED_MARKER.to_string()), None]);
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM action_items").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 1, "the table keeps its rows");

        assert_eq!(restore_action_sections(&pool).await.unwrap(), 0, "a second launch changes nothing");
    }
}
