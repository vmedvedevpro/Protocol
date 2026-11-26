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
//! No item is dropped silently. A meeting is marked only when every row of
//! the user's is in its summary. One with no summary yet, or a summary not
//! stored as Markdown, is logged and stays unmarked; the summary service
//! calls `restore_after_summary` when it writes a summary, which puts the
//! rows into it. Each summary is copied to `backup_dir` before it changes.
//!
//! The `action_items` table stays as it is (released migrations never
//! change); nothing reads or writes its rows for display any more, except
//! contact merges and deletions that keep their owner links consistent.

use std::io::Write;
use std::path::{Path, PathBuf};

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

/// The line ranges `[heading, end)` of every action section with some text
/// under its heading. A section runs from its heading to the next heading at
/// the same or a higher level; a bold heading ends at any heading.
fn action_section_ranges(lines: &[&str]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
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
            ranges.push((index, end));
        }
        index = end;
    }
    ranges
}

/// Every action section with some text under its heading.
fn action_sections(markdown: &str) -> Vec<Section> {
    let lines: Vec<&str> = markdown.lines().collect();
    action_section_ranges(&lines)
        .into_iter()
        .map(|(start, end)| Section {
            text: lines[start..end].join("\n").trim_end().to_string(),
            before: lines.get(end).map(|line| line.trim().to_string()),
        })
        .collect()
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

// How the old UI turned an action section into rows
// (`actionItemText.ts`, `parseSectionBody` and `parseActionLine`), ported so
// that an unedited row's text is found again as the whole item it came from.
static BOLD: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*\*(.+?)\*\*").expect("bold pattern"));
static UNDERLINE_BOLD: Lazy<Regex> = Lazy::new(|| Regex::new(r"__(.+?)__").expect("bold pattern"));
static CODE: Lazy<Regex> = Lazy::new(|| Regex::new(r"`([^`]+)`").expect("code pattern"));
static LIST_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*(?:[-*+•]|\d+[.)])\s+").expect("list pattern"));
static CHECKBOX_PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\[[ xX]\]\s*").expect("checkbox pattern"));
/// A list item a done mark can go on: its indent, its checkbox, its text.
static LIST_ITEM: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(\s*)(?:[-*+•]|\d+[.)])\s+(?:\[([ xX])\]\s*)?(.*)$").expect("item pattern"));
static INDENTED_ITEM: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(?:\s{2,}|\t)(?:[-*+•]|\d+[.)])").expect("sub-item pattern"));
static RULE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[-=*_]{3,}$").expect("rule pattern"));
static OWNER_AT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^@([\p{L}][\p{L}.'’-]*(?:\s+[\p{Lu}][\p{L}.'’-]*)?)\s*[:,-]?\s+(.+)$").expect("owner pattern")
});
static OWNER_YOU: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(you|me)\s*[:\-–—]\s+(.+)$").expect("owner pattern"));
static OWNER_BRACKET: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\[([^\]]{1,40})\]\s*[:\-–—]?\s*(.+)$").expect("owner pattern"));
static OWNER_NAME: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^([\p{Lu}][\p{L}.'’-]+(?:\s+[\p{Lu}][\p{L}.'’-]+){0,2})\s*(?::|\s[–—-])\s+(.+)$").expect("owner pattern")
});
static NOT_AN_OWNER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)^(?:note|update|decision|summary|context|background)$").expect("owner pattern"));
static OWNER_TAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\s*[(\[]?\s*(?:owner|assignee|assigned to|owned by)\s*[:-]?\s*([\p{Lu}][\p{L}.'’-]+(?:\s+[\p{Lu}][\p{L}.'’-]+)?)\s*[)\]]?")
        .expect("owner pattern")
});
static DUE: Lazy<[Regex; 2]> = Lazy::new(|| {
    let months = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?";
    [
        Regex::new(&format!(
            r"(?i)\(?\s*(?:due|by|before|deadline:?)\s+((?:{months}\s+\d{{1,2}}(?:st|nd|rd|th)?(?:,?\s*\d{{4}})?)|\d{{4}}-\d{{2}}-\d{{2}}|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|tomorrow|today|tonight|eod|eow|end of (?:day|week|month))\s*\)?\.?$"
        ))
        .expect("due pattern"),
        Regex::new(r"(?i)\(\s*((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|today|eod|eow)\s*\)\.?$")
            .expect("due pattern"),
    ]
});
static TRAILING_PUNCTUATION: Lazy<Regex> = Lazy::new(|| Regex::new(r"[\s,;–—-]+$").expect("punctuation pattern"));

/// No bold or code marks, one space.
fn strip_inline(text: &str) -> String {
    let text = BOLD.replace_all(text, "$1");
    let text = UNDERLINE_BOLD.replace_all(&text, "$1");
    let text = CODE.replace_all(&text, "$1");
    SPACES.replace_all(&text, " ").trim().to_string()
}

/// The text the old UI kept of one action line: without its list mark,
/// checkbox, owner and due date.
fn action_line_text(line: &str) -> String {
    let mut text = strip_inline(&CHECKBOX_PREFIX.replace(&LIST_PREFIX.replace(line, ""), ""));
    let owned = [&*OWNER_AT, &*OWNER_YOU, &*OWNER_BRACKET]
        .iter()
        .find_map(|pattern| pattern.captures(&text).map(|found| found[2].to_string()))
        .or_else(|| {
            OWNER_NAME
                .captures(&text)
                .filter(|found| !NOT_AN_OWNER.is_match(&found[1]))
                .map(|found| found[2].to_string())
        });
    match owned {
        Some(rest) => text = rest,
        None => {
            if let Some(tag) = OWNER_TAG.find(&text).map(|found| found.as_str().to_string()) {
                text = text.replacen(&tag, " ", 1);
            }
        }
    }
    if let Some(due) = DUE.iter().find_map(|pattern| pattern.find(&text)) {
        text.truncate(due.start());
    }
    let text = TRAILING_PUNCTUATION.replace(&text, "");
    SPACES.replace_all(&text, " ").trim().to_string()
}

/// A table row's cells; `\|` is a pipe inside a cell, not a column break.
fn table_cells(row: &str) -> Vec<String> {
    let mut body = row.trim();
    body = body.strip_prefix('|').unwrap_or(body);
    if body.ends_with('|') && !body.ends_with("\\|") {
        body = &body[..body.len() - 1];
    }
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut chars = body.chars().peekable();
    while let Some(char) = chars.next() {
        match char {
            '\\' if chars.peek() == Some(&'|') => {
                cell.push('|');
                chars.next();
            }
            '|' => cells.push(strip_inline(&std::mem::take(&mut cell))),
            other => cell.push(other),
        }
    }
    cells.push(strip_inline(&cell));
    cells
}

/// One item of an action section: a line, or a table row, and every text a
/// row made from it could have (`comparable`).
#[derive(Debug)]
struct Item {
    line: usize,
    /// A list item, which can carry a done mark as a `- [x]` task item. A
    /// table row cannot.
    list: bool,
    texts: Vec<String>,
}

/// The items of the action sections at `ranges`: each list or text line, each
/// table cell, and a parent item with its sub-points joined by "; ", as the
/// old UI made one row of them.
fn section_items(lines: &[&str], ranges: &[(usize, usize)]) -> Vec<Item> {
    let mut items: Vec<Item> = Vec::new();
    for &(start, end) in ranges {
        let mut parent: Option<(usize, String)> = None;
        for (at, line) in lines.iter().enumerate().take(end).skip(start + 1) {
            let trimmed = line.trim();
            if trimmed.is_empty() || heading_of(trimmed).is_some() || RULE.is_match(trimmed) {
                continue;
            }
            if trimmed.starts_with('|') {
                let texts = table_cells(trimmed).iter().map(|cell| comparable(cell)).collect();
                items.push(Item { line: at, list: false, texts });
                continue;
            }
            let content = strip_inline(&LIST_PREFIX.replace(trimmed, ""));
            let text = action_line_text(trimmed);
            let indented = INDENTED_ITEM.is_match(line);
            if indented {
                if let Some((index, joined)) = parent.as_mut() {
                    *joined = SPACES.replace_all(&format!("{joined}; {content}"), " ").to_string();
                    items[*index].texts.push(comparable(joined));
                }
            }
            items.push(Item { line: at, list: LIST_ITEM.is_match(line), texts: vec![comparable(&content), comparable(&text)] });
            if !indented {
                parent = Some((items.len() - 1, text));
            }
        }
    }
    items
}

/// `line` as a checked task item, or `None` when it is one already or is not
/// a list item.
fn checked_off(line: &str) -> Option<String> {
    let found = LIST_ITEM.captures(line)?;
    if found.get(2).is_some_and(|mark| mark.as_str().eq_ignore_ascii_case("x")) {
        return None;
    }
    Some(format!("{}- [x] {}", &found[1], &found[3]))
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
    /// A row the user added, changed or checked off (checking one sets
    /// `edited`), which the summary text does not hold as it is.
    fn is_users(&self) -> bool {
        self.source == "user" || self.edited
    }

    /// "- [x] Priya Shah: Send the terms (due Friday)": a task item, so the
    /// editor shows the done mark as its checkbox.
    fn render(&self) -> String {
        let text = SPACES.replace_all(self.text.trim(), " ");
        let check = if self.done { 'x' } else { ' ' };
        let owner = self.owner_label.as_deref().map(str::trim).filter(|owner| !owner.is_empty());
        let due = match self.due_text.as_deref().map(str::trim).filter(|due| !due.is_empty()) {
            Some(due) => format!(" (due {due})"),
            None => String::new(),
        };
        match owner {
            Some(owner) => format!("- [{check}] {owner}: {text}{due}"),
            None => format!("- [{check}] {text}{due}"),
        }
    }
}

/// Text for "is this the same item": no emphasis, one space, lower case.
fn comparable(text: &str) -> String {
    SPACES.replace_all(&text.replace("**", "").replace("__", "").replace('`', ""), " ").trim().to_lowercase()
}

/// Which rows to write into the summary besides the items it already has.
#[derive(Debug, Clone, Copy, PartialEq)]
enum RowsToAdd {
    /// The summary, or the section that comes back from `original_markdown`,
    /// holds the model's items: only the user's own rows can be missing.
    UsersOnly,
    /// The summary was read and has no original to take the section from
    /// (edited after the move): every row.
    All,
}

/// What asks for a meeting's restore.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Trigger {
    /// The startup step. `was_read`: the old UI read this summary for items
    /// (`action_items_source` was set).
    Launch { was_read: bool },
    /// A summary was just written for a meeting whose items no summary held
    /// yet. Its action section, if any, is the model's new one: only the
    /// user's rows join it.
    NewSummary,
}

/// What `restored_summary` made of a stored summary.
#[derive(Debug, PartialEq)]
enum Restored {
    Changed(Value),
    /// Every item it should hold is there.
    Unchanged,
    /// Not an object with Markdown (a legacy map of sections, plain text):
    /// nothing can be put into it.
    NoMarkdown,
}

/// The summary `value` with its action items back.
///
/// A row is in the summary when its text is a whole item of an action
/// section: a list or text line (also without its owner and due date, as the
/// old UI read it) or a table cell. Never a substring: a hand-added "Budget"
/// is not in "Review the budget", and an edited row is added next to the
/// line it came from rather than dropped. A rare duplicate beats a lost
/// item. A done row found as a list item checks that item off (`- [x]`); a
/// table row has no place for the mark, which is not kept.
fn restored_summary(value: &Value, rows: &[ActionRow], trigger: Trigger) -> Restored {
    let Some((object, current)) = value
        .as_object()
        .and_then(|object| Some((object, object.get("markdown")?.as_str()?)))
    else {
        return Restored::NoMarkdown;
    };
    let in_place = !action_section_ranges(&current.lines().collect::<Vec<_>>()).is_empty();
    // Still there (the move never finished, the user typed one, or a new
    // summary has its own): nothing comes back from the original.
    let sections = match (in_place, object.get("original_markdown").and_then(Value::as_str)) {
        (false, Some(original)) => action_sections(original),
        _ => Vec::new(),
    };
    let wanted = match trigger {
        Trigger::Launch { was_read: true } if !in_place && sections.is_empty() => RowsToAdd::All,
        _ => RowsToAdd::UsersOnly,
    };
    let joined = sections.iter().fold(current.to_string(), |text, section| insert_section(&text, section));
    let mut lines: Vec<String> = joined.lines().map(str::to_string).collect();
    let (ranges, checked, missing) = {
        let view: Vec<&str> = lines.iter().map(String::as_str).collect();
        let ranges = action_section_ranges(&view);
        let items = section_items(&view, &ranges);
        let mut checked = Vec::new();
        let mut missing = Vec::new();
        for row in rows.iter().filter(|row| wanted == RowsToAdd::All || row.is_users()) {
            let text = comparable(&strip_inline(&row.text));
            if text.is_empty() {
                continue;
            }
            match items.iter().find(|item| item.texts.contains(&text)) {
                Some(item) if row.done && item.list => checked.extend(checked_off(&lines[item.line]).map(|line| (item.line, line))),
                Some(_) => {}
                None => missing.push(row.render()),
            }
        }
        (ranges, checked, missing)
    };
    if sections.is_empty() && checked.is_empty() && missing.is_empty() {
        return Restored::Unchanged;
    }
    for (at, line) in checked {
        lines[at] = line;
    }
    let mut markdown = lines.join("\n");
    if !missing.is_empty() {
        match ranges.last() {
            Some(&(_, end)) => {
                let mut at = end;
                while lines[at - 1].trim().is_empty() {
                    at -= 1;
                }
                // A list straight under a table row reads as one more row to
                // some Markdown readers; a blank line ends the table.
                let mut added = missing;
                if lines[at - 1].trim_start().starts_with('|') {
                    added.insert(0, String::new());
                }
                lines.splice(at..at, added);
                markdown = lines.join("\n");
            }
            None => {
                let section = Section {
                    text: format!("{RENDERED_HEADING}\n\n{}", missing.join("\n")),
                    // Where the design put the item list: before "Open questions".
                    before: lines
                        .iter()
                        .find(|line| heading_of(line).is_some_and(|(_, text)| normalize_heading(&text).starts_with("open questions")))
                        .map(|line| line.trim().to_string()),
                };
                markdown = insert_section(&markdown, &section);
            }
        }
    }
    let mut restored = object.clone();
    restored.insert("markdown".to_string(), Value::String(markdown));
    // The editor shows stored blocks before the Markdown; blocks without the
    // items would hide them. Dropping the blocks is safe: the editor saves
    // them together with this Markdown from the same document (SummaryPanel,
    // `saveSummary`), search, export and agents read the Markdown already,
    // and the editor builds its blocks again from it (headings, lists, task
    // items with their marks, tables, emphasis, links; NotesEditor.test.tsx).
    // What only the blocks held (text colour, alignment), the Markdown never
    // carried; the summary's backup keeps it (`back_up`).
    restored.remove("summary_json");
    Restored::Changed(Value::Object(restored))
}

/// Where the restore keeps each summary as it was before changing it.
pub fn backup_dir(data_root: &Path) -> PathBuf {
    data_root.join("summary-backups")
}

/// Writes the stored `result` of `meeting_id` to a new file in `dir`, before
/// it changes. A file is never overwritten, so the first one is the summary
/// as the old version left it. To recover, put its `result` back into
/// `summary_processes.result`.
fn back_up(dir: &Path, meeting_id: &str, result: &str) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let name: String = meeting_id
        .chars()
        .map(|char| if char.is_ascii_alphanumeric() || char == '-' || char == '_' { char } else { '_' })
        .collect();
    let now = chrono::Utc::now();
    let body = serde_json::to_vec_pretty(&serde_json::json!({
        "meeting_id": meeting_id,
        "saved_at": now.to_rfc3339(),
        "reason": "summary_processes.result before Protocol put its action items back into it (#218)",
        "result": result,
    }))?;
    let stamp = now.format("%Y%m%dT%H%M%S%3fZ");
    let mut attempt = 0;
    loop {
        let path = match attempt {
            0 => dir.join(format!("{name}-{stamp}.json")),
            n => dir.join(format!("{name}-{stamp}-{n}.json")),
        };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(&body)?;
                file.sync_all()?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => attempt += 1,
            Err(error) => return Err(error),
        }
    }
}

/// The meetings still to restore: read by the old UI and not restored yet,
/// or never read but holding rows of the user's. Every other meeting has
/// nothing to restore, so a launch does not read it. Binds the marker.
const PENDING: &str = "((m.action_items_source IS NOT NULL AND m.action_items_source != ?) \
     OR (m.action_items_source IS NULL AND EXISTS (SELECT 1 FROM action_items a \
         WHERE a.meeting_id = m.id AND (a.source = 'user' OR a.edited != 0))))";

/// Restores every meeting not yet restored. Answers how many summaries changed.
pub async fn restore_action_sections(pool: &SqlitePool, backups: &Path) -> Result<usize, sqlx::Error> {
    let meetings: Vec<(String, Option<String>)> =
        sqlx::query_as(&format!("SELECT m.id, m.action_items_source FROM meetings m WHERE {PENDING}"))
            .bind(RESTORED_MARKER)
            .fetch_all(pool)
            .await?;
    let mut changed = 0;
    for (meeting_id, source) in meetings {
        match restore_meeting(pool, backups, &meeting_id, Trigger::Launch { was_read: source.is_some() }).await {
            Ok(Outcome::Changed(_)) => changed += 1,
            Ok(Outcome::Unchanged | Outcome::Waiting) => {}
            Err(error) => warn!("Could not put the action items back into the summary of {meeting_id}: {error:#}"),
        }
    }
    if changed > 0 {
        info!("Put the action items back into {changed} summaries");
    }
    Ok(changed)
}

/// After a summary of `meeting_id` is written: puts in the user's items that
/// no summary held yet (the restore left the meeting unmarked). Answers the
/// summary as stored when it changed. Any other meeting costs one query.
pub async fn restore_after_summary(
    pool: &SqlitePool,
    backups: &Path,
    meeting_id: &str,
) -> anyhow::Result<Option<Value>> {
    let pending: Option<i64> = sqlx::query_scalar(&format!("SELECT 1 FROM meetings m WHERE m.id = ? AND {PENDING}"))
        .bind(meeting_id)
        .bind(RESTORED_MARKER)
        .fetch_optional(pool)
        .await?;
    if pending.is_none() {
        return Ok(None);
    }
    Ok(match restore_meeting(pool, backups, meeting_id, Trigger::NewSummary).await? {
        Outcome::Changed(summary) => Some(summary),
        Outcome::Unchanged | Outcome::Waiting => None,
    })
}

/// What a meeting's restore did.
#[derive(Debug, PartialEq)]
enum Outcome {
    /// The summary changed (stored, backed up, marked).
    Changed(Value),
    /// The summary holds every item already, or there was nothing to restore.
    Unchanged,
    /// The user's rows have no summary to go into: left unmarked, so a later
    /// summary of the meeting (`restore_after_summary`) takes them.
    Waiting,
}

/// One meeting, in one transaction with its marker. The marker is set only
/// when every row of the user's is in the summary: rows nothing else reads
/// must not be left behind silently.
async fn restore_meeting(pool: &SqlitePool, backups: &Path, meeting_id: &str, trigger: Trigger) -> anyhow::Result<Outcome> {
    let mut tx = pool.begin().await?;
    let rows: Vec<ActionRow> = sqlx::query_as(
        "SELECT text, owner_label, due_text, done, source, edited FROM action_items \
         WHERE meeting_id = ? ORDER BY position, created_at",
    )
    .bind(meeting_id)
    .fetch_all(&mut *tx)
    .await?;
    let users = rows.iter().any(ActionRow::is_users);
    if trigger == (Trigger::Launch { was_read: false }) && !users {
        // Never read, nothing of the user's: nothing to restore.
        return Ok(Outcome::Unchanged);
    }
    let result: Option<String> = sqlx::query_scalar("SELECT result FROM summary_processes WHERE meeting_id = ?")
        .bind(meeting_id)
        .fetch_optional(&mut *tx)
        .await?
        .flatten();
    let restored = result.as_deref().map(|raw| match serde_json::from_str::<Value>(raw) {
        Ok(value) => restored_summary(&value, &rows, trigger),
        Err(_) => Restored::NoMarkdown,
    });
    let changed = match restored {
        Some(Restored::Changed(summary)) => {
            let path = back_up(backups, meeting_id, result.as_deref().unwrap_or_default())?;
            info!("Kept the summary of {meeting_id} as it was in {}", path.display());
            // `user_edited` and `updated_at` stay: the text is what the model
            // and the user wrote, only put back together.
            sqlx::query("UPDATE summary_processes SET result = ? WHERE meeting_id = ?")
                .bind(summary.to_string())
                .bind(meeting_id)
                .execute(&mut *tx)
                .await?;
            Some(summary)
        }
        Some(Restored::Unchanged) => None,
        None | Some(Restored::NoMarkdown) if users => {
            if result.is_none() {
                warn!(
                    "Meeting {meeting_id} has action items of the user's but no summary yet; \
                     they go into its summary when one is written"
                );
            } else {
                warn!(
                    "Meeting {meeting_id} has action items of the user's, but its summary is not stored as \
                     Markdown; they stay in the action_items table until a new summary is written"
                );
            }
            tx.rollback().await?;
            return Ok(Outcome::Waiting);
        }
        // No summary, or none with Markdown, and only the model's rows: they
        // came from a summary that is gone or that never lost its section.
        None | Some(Restored::NoMarkdown) => None,
    };
    sqlx::query("UPDATE meetings SET action_items_source = ? WHERE id = ?")
        .bind(RESTORED_MARKER)
        .bind(meeting_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(changed.map_or(Outcome::Unchanged, Outcome::Changed))
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

    const LAUNCH: Trigger = Trigger::Launch { was_read: true };

    const ORIGINAL: &str = "## Summary\n\nWe planned the launch.\n\n## Action Items\n\n| **Owner** | Task | Due |\n| --- | --- | --- |\n| Priya | Send the terms | Friday |\n\n## Open questions\n\n- Pricing?";

    fn markdown(restored: Restored) -> String {
        match restored {
            Restored::Changed(value) => value["markdown"].as_str().unwrap().to_string(),
            other => panic!("expected a change, got {other:?}"),
        }
    }

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
    fn reads_an_action_line_as_the_old_ui_did() {
        assert_eq!(action_line_text("- **Priya**: Send the terms (due Friday)"), "Send the terms");
        assert_eq!(action_line_text("1. @sam: Book the room by tomorrow"), "Book the room");
        assert_eq!(action_line_text("- [x] You — Draft the FAQ"), "Draft the FAQ");
        assert_eq!(action_line_text("- Update the deck (owner: Lena)"), "Update the deck");
        assert_eq!(action_line_text("- Note: nothing else"), "Note: nothing else");
        assert_eq!(table_cells(r"| Priya | Pipes \| and more | Fri |"), ["Priya", "Pipes | and more", "Fri"]);
    }

    #[test]
    fn a_moved_section_comes_back_where_it_was() {
        let moved = json!({"markdown": "## Summary\n\nWe planned the launch.\n\n## Open questions\n\n- Pricing?", "original_markdown": ORIGINAL});
        let restored = restored_summary(&moved, &[row("Send the terms", Some("Priya"), "ai", false)], LAUNCH);
        let Restored::Changed(restored) = restored else { panic!("{restored:?}") };
        assert_eq!(restored["markdown"], ORIGINAL);
        assert_eq!(restored["original_markdown"], ORIGINAL, "the original stays as it was");
    }

    #[test]
    fn a_section_that_ended_the_summary_goes_back_at_the_end() {
        let original = "## Summary\n\nShort.\n\n**Next steps**\n- Book the room";
        let moved = json!({"markdown": "## Summary\n\nShort.", "original_markdown": original});
        assert_eq!(markdown(restored_summary(&moved, &[], LAUNCH)), original);
    }

    #[test]
    fn the_users_own_items_join_the_restored_section() {
        let moved = json!({"markdown": "## Summary\n\nWe planned the launch.\n\n## Open questions\n\n- Pricing?", "original_markdown": ORIGINAL});
        let rows = [
            row("Send the terms", Some("Priya"), "ai", false),
            row("Call the venue", None, "user", false),
            ActionRow { due_text: Some("Monday".into()), done: true, ..row("Draft the FAQ", Some("You"), "ai", true) },
        ];
        let markdown = markdown(restored_summary(&moved, &rows, LAUNCH));
        assert!(
            markdown.contains("| Priya | Send the terms | Friday |\n\n- [ ] Call the venue\n- [x] You: Draft the FAQ (due Monday)\n\n## Open questions"),
            "{markdown}"
        );
    }

    #[test]
    fn a_summary_edited_after_the_move_gets_its_rows_rendered() {
        let edited = json!({"markdown": "## Summary\n\nEdited by hand.\n\n## Open questions\n\n- Pricing?", "summary_json": [{"type": "paragraph"}]});
        let rows = [row("Send the terms", Some("Priya"), "ai", false), row("Book the room", None, "user", false)];
        let Restored::Changed(restored) = restored_summary(&edited, &rows, LAUNCH) else { panic!() };
        assert_eq!(
            restored["markdown"],
            "## Summary\n\nEdited by hand.\n\n## Action Items\n\n- [ ] Priya: Send the terms\n- [ ] Book the room\n\n## Open questions\n\n- Pricing?"
        );
        assert!(restored.get("summary_json").is_none(), "stale blocks would hide the section");
    }

    #[test]
    fn an_item_is_found_whole_never_inside_another() {
        // "Budget" is a word of the summary and of an item, but no item of its own.
        let summary = json!({"markdown": "## Summary\n\nBudget talk.\n\n## Action Items\n\n- Review the budget numbers\n- Budget sheet: Lena"});
        let markdown = markdown(restored_summary(&summary, &[row("Budget", None, "user", false)], LAUNCH));
        assert_eq!(markdown, "## Summary\n\nBudget talk.\n\n## Action Items\n\n- Review the budget numbers\n- Budget sheet: Lena\n- [ ] Budget");

        // The same item, whatever its emphasis or case, is not added twice.
        let summary = json!({"markdown": "## Action Items\n\n- **Call the venue**"});
        assert_eq!(restored_summary(&summary, &[row("call the venue", None, "user", false)], LAUNCH), Restored::Unchanged);
    }

    #[test]
    fn an_edited_item_is_added_next_to_the_line_it_came_from() {
        let moved = json!({
            "markdown": "## Summary\n\nTerms.",
            "original_markdown": "## Summary\n\nTerms.\n\n## Next steps\n\n- Priya: Send the terms to legal by Friday",
        });
        // The user shortened the model's item: its text is inside the line, not the line.
        let rows = [row("Send the terms", Some("Priya"), "ai", true)];
        assert_eq!(
            markdown(restored_summary(&moved, &rows, LAUNCH)),
            "## Summary\n\nTerms.\n\n## Next steps\n\n- Priya: Send the terms to legal by Friday\n- [ ] Priya: Send the terms"
        );
    }

    #[test]
    fn a_done_mark_checks_off_its_list_item() {
        let moved = json!({
            "markdown": "## Summary\n\nTerms.",
            "original_markdown": "## Summary\n\nTerms.\n\n## Action items\n\n- **Priya**: Send the terms (due Friday)\n  - legal first\n- Book the room\n1. [x] Print the deck",
        });
        let rows = [
            // Checking an item off set `edited` in the old UI.
            ActionRow { done: true, ..row("Send the terms; legal first", Some("Priya"), "ai", true) },
            ActionRow { done: true, ..row("Print the deck", None, "ai", true) },
            row("Book the room", None, "ai", false),
        ];
        assert_eq!(
            markdown(restored_summary(&moved, &rows, LAUNCH)),
            "## Summary\n\nTerms.\n\n## Action items\n\n- [x] **Priya**: Send the terms (due Friday)\n  - legal first\n- Book the room\n1. [x] Print the deck"
        );

        // A table row has no place for it: the row stays, unmarked.
        let table = json!({"markdown": ORIGINAL});
        let done = [ActionRow { done: true, ..row("Send the terms", Some("Priya"), "ai", true) }];
        assert_eq!(restored_summary(&table, &done, LAUNCH), Restored::Unchanged);
    }

    #[test]
    fn nothing_changes_when_the_section_is_there_or_there_is_nothing_to_add() {
        let intact = json!({"markdown": ORIGINAL, "original_markdown": ORIGINAL});
        assert_eq!(restored_summary(&intact, &[row("Send the terms", None, "ai", false)], LAUNCH), Restored::Unchanged);
        let no_items = json!({"markdown": "## Summary\n\nNothing to do."});
        assert_eq!(restored_summary(&no_items, &[], LAUNCH), Restored::Unchanged);
        // A summary the old UI never read keeps its text; only the user's rows are added.
        let unread = json!({"markdown": "## Summary\n\nNew run."});
        let never_read = Trigger::Launch { was_read: false };
        assert_eq!(restored_summary(&unread, &[row("Old AI item", None, "ai", false)], never_read), Restored::Unchanged);
        assert_eq!(restored_summary(&json!("plain text"), &[row("Call", None, "user", false)], LAUNCH), Restored::NoMarkdown);
    }

    #[test]
    fn a_new_summary_keeps_its_own_section_and_takes_the_users_items() {
        let fresh = json!({"markdown": "## Summary\n\nNew.\n\n## Action Items\n\n- Ship it"});
        let rows = [row("Old model item", None, "ai", false), row("Call the venue", None, "user", false)];
        assert_eq!(
            markdown(restored_summary(&fresh, &rows, Trigger::NewSummary)),
            "## Summary\n\nNew.\n\n## Action Items\n\n- Ship it\n- [ ] Call the venue"
        );
    }

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    async fn marker(pool: &SqlitePool, id: &str) -> Option<String> {
        sqlx::query_scalar("SELECT action_items_source FROM meetings WHERE id = ?").bind(id).fetch_one(pool).await.unwrap()
    }

    async fn stored(pool: &SqlitePool, id: &str) -> String {
        sqlx::query_scalar("SELECT result FROM summary_processes WHERE meeting_id = ?").bind(id).fetch_one(pool).await.unwrap()
    }

    fn backups(dir: &Path) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
        entries
            .map(|entry| serde_json::from_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap()).unwrap())
            .collect()
    }

    #[tokio::test]
    async fn the_startup_step_restores_once_and_marks_the_meeting() {
        let pool = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let moved = json!({"markdown": "## Summary\n\nWe planned the launch.\n\n## Open questions\n\n- Pricing?", "original_markdown": ORIGINAL});
        sqlx::raw_sql(&format!(
            "INSERT INTO meetings (id, title, created_at, updated_at, action_items_source) VALUES \
                 ('m1', 'Launch', '2026-10-01', '2026-10-01', 'abc-12'), \
                 ('m2', 'Fresh', '2026-10-02', '2026-10-02', NULL), \
                 ('m3', 'Model rows only', '2026-10-03', '2026-10-03', NULL); \
             INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result, user_edited) VALUES \
                 ('m1', 'completed', '2026-10-01', '2026-10-01', '{}', 0), \
                 ('m2', 'completed', '2026-10-02', '2026-10-02', '{{\"markdown\":\"## Summary\"}}', 0); \
             INSERT INTO action_items (id, meeting_id, text, owner_label, source, position, created_at, updated_at) VALUES \
                 ('a1', 'm1', 'Send the terms', 'Priya', 'ai', 0, '2026-10-01', '2026-10-01'), \
                 ('a2', 'm3', 'Left by a model', NULL, 'ai', 0, '2026-10-03', '2026-10-03');",
            moved.to_string().replace('\'', "''")
        ))
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(restore_action_sections(&pool, dir.path()).await.unwrap(), 1);
        let (result, edited): (String, bool) =
            sqlx::query_as("SELECT result, user_edited FROM summary_processes WHERE meeting_id = 'm1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap()["markdown"], ORIGINAL);
        assert!(!edited);
        assert_eq!(marker(&pool, "m1").await.as_deref(), Some(RESTORED_MARKER));
        assert_eq!(marker(&pool, "m2").await, None);
        assert_eq!(marker(&pool, "m3").await, None, "nothing of the user's: not read at all");
        let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM action_items").fetch_one(&pool).await.unwrap();
        assert_eq!(rows, 2, "the table keeps its rows");

        // The summary as it was is kept, to recover from.
        let kept = backups(dir.path());
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0]["meeting_id"], "m1");
        assert_eq!(serde_json::from_str::<Value>(kept[0]["result"].as_str().unwrap()).unwrap(), moved);

        assert_eq!(restore_action_sections(&pool, dir.path()).await.unwrap(), 0, "a second launch changes nothing");
        assert_eq!(backups(dir.path()).len(), 1);
    }

    #[tokio::test]
    async fn the_users_items_wait_for_a_summary_and_go_into_it() {
        let pool = pool().await;
        let dir = tempfile::tempdir().unwrap();
        sqlx::raw_sql(
            "INSERT INTO meetings (id, title, created_at, updated_at, action_items_source) VALUES \
                 ('m1', 'No summary yet', '2026-10-01', '2026-10-01', NULL); \
             INSERT INTO action_items (id, meeting_id, text, done, source, edited, position, created_at, updated_at) VALUES \
                 ('a1', 'm1', 'Call the venue', 0, 'user', 0, 0, '2026-10-01', '2026-10-01'), \
                 ('a2', 'm1', 'Print the deck', 1, 'user', 0, 1, '2026-10-01', '2026-10-01');",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(restore_action_sections(&pool, dir.path()).await.unwrap(), 0);
        assert_eq!(marker(&pool, "m1").await, None, "no summary holds them: the meeting stays to restore");
        assert_eq!(restore_action_sections(&pool, dir.path()).await.unwrap(), 0, "and stays on the next launch");
        assert_eq!(marker(&pool, "m1").await, None);

        // A summary is written: the items go into it.
        sqlx::query(
            "INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) \
             VALUES ('m1', 'completed', '2026-10-02', '2026-10-02', ?)",
        )
        .bind(json!({"markdown": "## Summary\n\nWe met.\n\n## Action Items\n\n- Ship it"}).to_string())
        .execute(&pool)
        .await
        .unwrap();
        let summary = restore_after_summary(&pool, dir.path(), "m1").await.unwrap().expect("the summary changes");
        let expected = "## Summary\n\nWe met.\n\n## Action Items\n\n- Ship it\n- [ ] Call the venue\n- [x] Print the deck";
        assert_eq!(summary["markdown"], expected);
        assert_eq!(serde_json::from_str::<Value>(&stored(&pool, "m1").await).unwrap()["markdown"], expected);
        assert_eq!(marker(&pool, "m1").await.as_deref(), Some(RESTORED_MARKER));
        assert_eq!(backups(dir.path()).len(), 1);

        // The next summary of a restored meeting is left as the model wrote it.
        assert_eq!(restore_after_summary(&pool, dir.path(), "m1").await.unwrap(), None);
        assert_eq!(restore_after_summary(&pool, dir.path(), "missing").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_summary_without_markdown_keeps_the_users_items_waiting() {
        let pool = pool().await;
        let dir = tempfile::tempdir().unwrap();
        let legacy = json!({"_section_order": ["key_points"], "key_points": {"title": "Key points", "blocks": [{"content": "Budget"}]}});
        sqlx::raw_sql(&format!(
            "INSERT INTO meetings (id, title, created_at, updated_at, action_items_source) VALUES \
                 ('m1', 'Legacy', '2026-10-01', '2026-10-01', 'abc-12'); \
             INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) VALUES \
                 ('m1', 'completed', '2026-10-01', '2026-10-01', '{}'); \
             INSERT INTO action_items (id, meeting_id, text, source, position, created_at, updated_at) VALUES \
                 ('a1', 'm1', 'Call the venue', 'user', 0, '2026-10-01', '2026-10-01');",
            legacy.to_string().replace('\'', "''")
        ))
        .execute(&pool)
        .await
        .unwrap();

        assert_eq!(restore_action_sections(&pool, dir.path()).await.unwrap(), 0);
        assert_eq!(marker(&pool, "m1").await.as_deref(), Some("abc-12"), "not marked: the item is in no summary");
        assert_eq!(serde_json::from_str::<Value>(&stored(&pool, "m1").await).unwrap(), legacy);
        assert!(backups(dir.path()).is_empty());
    }
}
