//! What each tool reads and how its result reads. Every list is paged by
//! `offset` and capped twice: by a row limit and by the result's token budget
//! (`text::RESULT_TOKENS`); a result that stops early says how to get the
//! rest. Speaker labels and contacts come out exactly as Protocol stores them:
//! a "Speaker 2" is never turned into a name.
//!
//! Every query reaches a meeting's rows through `meetings`, so rows a deleted
//! meeting left behind in an old database without foreign keys never show.

use chrono::{DateTime, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use meeting_library::search::{self, escape_like, Kind, SearchFilter};
use meeting_library::{normalize_person_name, summary};
use schemars::JsonSchema;
use serde::Deserialize;
use sqlx::sqlite::SqliteArguments;
use sqlx::{Arguments, SqliteConnection};

use crate::store::Problem;
use crate::text::{self, clock, local_offset, local_time, one_line, quoted, range, Output};

/// Tokens kept free for the paging line at the end of a page.
const FOOTER: usize = 60;

fn limit(value: Option<u32>, default: usize, max: usize) -> usize {
    value.map_or(default, |value| (value as usize).clamp(1, max))
}

fn clean(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn arguments(binds: &[String]) -> SqliteArguments<'static> {
    let mut args = SqliteArguments::default();
    for value in binds {
        let _ = args.add(value.clone());
    }
    args
}

fn more_line(tool: &str, next_offset: usize, extra: &str) -> String {
    format!("More: call {tool} again with offset={next_offset}{extra} and the same other arguments.")
}

// ---------------------------------------------------------------------------
// Filters shared by the meeting-scoped tools
// ---------------------------------------------------------------------------

/// A start or end bound: a local calendar day, or an RFC 3339 instant.
fn bound(value: &str, end_of_day: bool, name: &str) -> Result<String, Problem> {
    let value = value.trim();
    if let Ok(day) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        let day = if end_of_day { day.succ_opt().unwrap_or(day) } else { day };
        let midnight = Local
            .from_local_datetime(&day.and_hms_opt(0, 0, 0).expect("midnight exists"))
            .earliest()
            .map(|time| time.with_timezone(&Utc))
            .unwrap_or_else(|| Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).expect("midnight")));
        let instant = if end_of_day {
            midnight - chrono::Duration::milliseconds(1)
        } else {
            midnight
        };
        return Ok(instant.to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    DateTime::parse_from_rfc3339(value)
        .map(|time| {
            time.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
        })
        .map_err(|_| {
            Problem::BadArgument(format!(
                "`{name}` must be a date like 2026-10-01 (a whole local day) or an RFC 3339 time \
                 like 2026-10-01T14:00:00+03:00; got {value:?}."
            ))
        })
}

/// Rows of `table` (`people` or `groups`) named by `value`: its id, else its
/// exact name, else every name containing it. Returns `(id, name)`.
async fn named(
    conn: &mut SqliteConnection,
    table: &str,
    name_column: &str,
    value: &str,
) -> Result<Vec<(String, String)>, Problem> {
    let by_id: Option<(String, String)> =
        sqlx::query_as(&format!("SELECT id, {name_column} FROM {table} WHERE id = ?"))
            .bind(value)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some(row) = by_id {
        return Ok(vec![row]);
    }
    let normalized = normalize_person_name(value);
    let exact: Vec<(String, String)> = sqlx::query_as(&format!(
        "SELECT id, {name_column} FROM {table} WHERE normalized_name = ? ORDER BY {name_column}"
    ))
    .bind(&normalized)
    .fetch_all(&mut *conn)
    .await?;
    if !exact.is_empty() {
        return Ok(exact);
    }
    Ok(sqlx::query_as(&format!(
        "SELECT id, {name_column} FROM {table} WHERE normalized_name LIKE ? ESCAPE '\\' \
         ORDER BY {name_column} COLLATE NOCASE LIMIT 20"
    ))
    .bind(format!("%{}%", escape_like(&normalized)))
    .fetch_all(&mut *conn)
    .await?)
}

/// Meeting filters resolved against the library, with a line saying what a
/// name matched, or the reason nothing can match.
struct Scope {
    filter: SearchFilter,
    notes: Vec<String>,
    nothing: Option<String>,
}

async fn scope(
    conn: &mut SqliteConnection,
    from: Option<String>,
    to: Option<String>,
    person: Option<String>,
    group: Option<String>,
) -> Result<Scope, Problem> {
    let mut scope = Scope {
        filter: SearchFilter::default(),
        notes: Vec::new(),
        nothing: None,
    };
    if let Some(from) = clean(from) {
        scope.filter.from = Some(bound(&from, false, "from")?);
    }
    if let Some(to) = clean(to) {
        scope.filter.to = Some(bound(&to, true, "to")?);
    }
    if let Some(person) = clean(person) {
        let people = named(conn, "people", "display_name", &person).await?;
        if people.is_empty() {
            scope.nothing = Some(format!(
                "No contact matches {person:?}. Contacts are the names given to speakers in \
                 Protocol (list_people shows them); anonymous labels such as \"Speaker 2\" are not \
                 contacts, but search finds them in transcripts."
            ));
        } else {
            scope.notes.push(format!(
                "Person {person:?} matched: {}.",
                people
                    .iter()
                    .map(|(id, name)| format!("{name} ({id})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        scope.filter.person_ids = Some(people.into_iter().map(|(id, _)| id).collect());
    }
    if let Some(group) = clean(group) {
        let groups = named(conn, "groups", "name", &group).await?;
        if groups.is_empty() && scope.nothing.is_none() {
            scope.nothing = Some(format!(
                "No group matches {group:?}; list_groups shows the groups."
            ));
        } else if !groups.is_empty() {
            scope.notes.push(format!(
                "Group {group:?} matched: {}.",
                groups
                    .iter()
                    .map(|(id, name)| format!("{name} ({id})"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        scope.filter.group_ids = Some(groups.into_iter().map(|(id, _)| id).collect());
    }
    Ok(scope)
}

// ---------------------------------------------------------------------------
// list_meetings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListMeetingsArgs {
    /// Only meetings that started on or after this: a date `YYYY-MM-DD` (from the start of that local day) or an RFC 3339 time.
    pub from: Option<String>,
    /// Only meetings that started on or before this: a date `YYYY-MM-DD` (to the end of that local day) or an RFC 3339 time.
    pub to: Option<String>,
    /// Only meetings in which this contact spoke: a person id from list_people, or a name (an exact name, else every contact whose name contains it).
    pub person: Option<String>,
    /// Only meetings filed in this group: a group id from list_groups, or a group name.
    pub group: Option<String>,
    /// Only meetings whose title contains this text.
    pub title: Option<String>,
    /// How many meetings to return, newest first. Default 20, at most 100.
    #[schemars(range(min = 1, max = 100))]
    pub limit: Option<u32>,
    /// How many meetings to skip; the result names the offset of the next page.
    pub offset: Option<u32>,
}

struct MeetingStats {
    lines: i64,
    seconds: Option<f64>,
}

async fn meeting_stats(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> Result<std::collections::HashMap<String, MeetingStats>, Problem> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    // `transcripts` has no index on meeting_id: one grouped pass over the
    // table costs about what one meeting's lookup does.
    let marks = vec!["?"; ids.len()].join(", ");
    let rows: Vec<(String, i64, Option<f64>)> = sqlx::query_as_with(
        &format!(
            "SELECT meeting_id, COUNT(*), \
                    MAX(COALESCE(audio_end_time, audio_start_time + COALESCE(duration, 0))) \
             FROM transcripts WHERE meeting_id IN ({marks}) GROUP BY meeting_id"
        ),
        arguments(ids),
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, lines, seconds)| (id, MeetingStats { lines, seconds }))
        .collect())
}

/// Contacts linked to each of `ids` through `person_speakers`, by name.
async fn meeting_people(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> Result<std::collections::HashMap<String, Vec<(String, String)>>, Problem> {
    if ids.is_empty() {
        return Ok(Default::default());
    }
    let marks = vec!["?"; ids.len()].join(", ");
    let rows: Vec<(String, String, String)> = sqlx::query_as_with(
        &format!(
            "SELECT DISTINCT ps.meeting_id, p.id, p.display_name \
             FROM person_speakers ps JOIN people p ON p.id = ps.person_id \
             WHERE ps.meeting_id IN ({marks}) ORDER BY p.display_name COLLATE NOCASE"
        ),
        arguments(ids),
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut by_meeting: std::collections::HashMap<String, Vec<(String, String)>> = Default::default();
    for (meeting, id, name) in rows {
        by_meeting.entry(meeting).or_default().push((id, name));
    }
    Ok(by_meeting)
}

pub async fn list_meetings(conn: &mut SqliteConnection, args: ListMeetingsArgs) -> Result<String, Problem> {
    let page = limit(args.limit, 20, 100);
    let offset = args.offset.unwrap_or(0) as usize;
    let scope = scope(conn, args.from, args.to, args.person, args.group).await?;
    if let Some(nothing) = scope.nothing {
        return Ok(nothing);
    }

    let mut binds = SqliteArguments::default();
    let mut condition = String::from(" WHERE 1 = 1");
    if let Some(title) = clean(args.title) {
        // Matched like Ctrl+K matches titles, in any letter case.
        condition.push_str(" AND unicode_lower(m.title) LIKE ? ESCAPE '\\'");
        let _ = binds.add(format!("%{}%", escape_like(&title.to_lowercase())));
    }
    condition.push_str(&scope.filter.meeting_clauses(&mut binds));

    let total: i64 = sqlx::query_scalar_with(
        &format!("SELECT COUNT(*) FROM meetings m{condition}"),
        binds.clone(),
    )
    .fetch_one(&mut *conn)
    .await?;
    let mut page_args = binds;
    let _ = page_args.add(page as i64);
    let _ = page_args.add(offset as i64);
    let rows: Vec<(String, String, String, Option<String>, Option<String>, bool)> = sqlx::query_as_with(
        &format!(
            "SELECT m.id, m.title, m.created_at, g.id, g.name, \
                    EXISTS (SELECT 1 FROM summary_processes s \
                            WHERE s.meeting_id = m.id AND s.result IS NOT NULL) \
             FROM meetings m LEFT JOIN groups g ON g.id = m.group_id{condition} \
             ORDER BY julianday(m.created_at) DESC, m.id LIMIT ? OFFSET ?"
        ),
        page_args,
    )
    .fetch_all(&mut *conn)
    .await?;

    let ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let stats = meeting_stats(conn, &ids).await?;
    let people = meeting_people(conn, &ids).await?;

    let mut out = Output::new();
    let total = total as usize;
    let mut shown = 0;
    let mut lines = Vec::new();
    for (id, title, created_at, group_id, group_name, has_summary) in &rows {
        let mut parts = vec![quoted(title), format!("id {id}"), local_time(created_at)];
        if let Some(stats) = stats.get(id) {
            if let Some(seconds) = stats.seconds {
                parts.push(text::duration(seconds));
            }
            parts.push(format!("{} transcript lines", stats.lines));
        } else {
            parts.push("no transcript".to_string());
        }
        if let (Some(group_id), Some(group_name)) = (group_id, group_name) {
            parts.push(format!("group {} ({group_id})", quoted(group_name)));
        }
        if let Some(names) = people.get(id) {
            parts.push(format!(
                "people: {}",
                names
                    .iter()
                    .map(|(_, name)| name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        parts.push(if *has_summary { "summary" } else { "no summary" }.to_string());
        lines.push(format!("- {}", parts.join(" · ")));
    }

    out.line(format!(
        "Meetings {}, newest first. Times are local ({}).",
        range(offset, rows.len(), total),
        local_offset()
    ));
    for note in &scope.notes {
        out.line(note);
    }
    for line in &lines {
        if !out.fit(line, FOOTER) {
            break;
        }
        shown += 1;
    }
    if offset + shown < total {
        out.line(more_line("list_meetings", offset + shown, ""));
    }
    Ok(out.finish())
}

// ---------------------------------------------------------------------------
// get_meeting / get_transcript
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetMeetingArgs {
    /// The meeting's id, from list_meetings or search.
    pub meeting_id: String,
    /// Also return the transcript, as much as fits; get_transcript reads the rest. Default false.
    pub include_transcript: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetTranscriptArgs {
    /// The meeting's id, from list_meetings or search.
    pub meeting_id: String,
    /// How many lines to skip; the result names the offset of the next page.
    pub offset: Option<u32>,
    /// Most lines to return. Default 200, at most 500; a page also stops at the size limit.
    #[schemars(range(min = 1, max = 500))]
    pub limit: Option<u32>,
}

struct MeetingHead {
    id: String,
    title: String,
    created_at: String,
    group: Option<(String, String)>,
}

async fn meeting_head(conn: &mut SqliteConnection, meeting_id: &str) -> Result<MeetingHead, Problem> {
    let row: Option<(String, String, String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT m.id, m.title, m.created_at, g.id, g.name \
         FROM meetings m LEFT JOIN groups g ON g.id = m.group_id WHERE m.id = ?",
    )
    .bind(meeting_id.trim())
    .fetch_optional(&mut *conn)
    .await?;
    let Some((id, title, created_at, group_id, group_name)) = row else {
        return Err(Problem::NotFound(format!(
            "No meeting has the id {:?}. Meeting ids come from list_meetings and search; a \
             meeting deleted in Protocol is gone.",
            meeting_id.trim()
        )));
    };
    Ok(MeetingHead {
        id,
        title,
        created_at,
        group: group_id.zip(group_name),
    })
}

struct TranscriptLine {
    speaker: Option<String>,
    start: Option<f64>,
    end: Option<f64>,
    text: String,
}

impl TranscriptLine {
    fn label(&self) -> &str {
        self.speaker.as_deref().map(str::trim).unwrap_or_default()
    }

    /// `previous` is the label of the line above on the same page: a label is
    /// written only where it changes.
    fn render(&self, previous: Option<&str>) -> String {
        let time = match (self.start, self.end) {
            (Some(start), Some(end)) if end > start => format!("[{}–{}] ", clock(start), clock(end)),
            (Some(start), _) => format!("[{}] ", clock(start)),
            _ => String::new(),
        };
        let label = self.label();
        let speaker = match previous {
            Some(previous) if previous == label => String::new(),
            Some(_) if label.is_empty() => "(no label): ".to_string(),
            _ if label.is_empty() => String::new(),
            _ => format!("{label}: "),
        };
        format!("{time}{speaker}{}", one_line(&self.text))
    }
}

async fn transcript_lines(
    conn: &mut SqliteConnection,
    meeting_id: &str,
    offset: usize,
    count: usize,
) -> Result<(Vec<TranscriptLine>, usize), Problem> {
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcripts WHERE meeting_id = ?")
        .bind(meeting_id)
        .fetch_one(&mut *conn)
        .await?;
    // The order of the app's transcript view (`audio_start_time` first), with
    // ties broken so pages never overlap.
    let rows: Vec<(Option<String>, Option<f64>, Option<f64>, Option<f64>, String)> = sqlx::query_as(
        "SELECT speaker, audio_start_time, audio_end_time, duration, transcript FROM transcripts \
         WHERE meeting_id = ? ORDER BY audio_start_time, timestamp, id LIMIT ? OFFSET ?",
    )
    .bind(meeting_id)
    .bind(count as i64)
    .bind(offset as i64)
    .fetch_all(&mut *conn)
    .await?;
    Ok((
        rows.into_iter()
            .map(|(speaker, start, end, duration, text)| TranscriptLine {
                speaker,
                start,
                end: end.or_else(|| start.zip(duration).map(|(start, duration)| start + duration)),
                text,
            })
            .collect(),
        total as usize,
    ))
}

/// Writes transcript lines while they fit; returns how many were written.
fn write_lines(out: &mut Output, lines: &[TranscriptLine]) -> usize {
    let mut written: usize = 0;
    for line in lines {
        let previous = written.checked_sub(1).map(|index| lines[index].label());
        let rendered = line.render(previous);
        let rendered = if written == 0 && text::estimated_tokens(&rendered) > out.room(FOOTER) {
            // One line larger than a whole page: show it cut rather than never.
            text::clip(&rendered, out.room(FOOTER))
        } else {
            rendered
        };
        if !out.fit(&rendered, FOOTER) {
            break;
        }
        written += 1;
    }
    written
}

const SPEAKER_NOTE: &str = "Speaker labels are Protocol's: \"You\" is this computer's microphone, \
\"Guest\" its sound output (the other side of a call) before voices were told apart, \"Speaker N\" an unnamed voice, \"A + B\" voices that overlapped; other labels are names the user gave. \
A line without a label continues the speaker above it.";

pub async fn get_meeting(conn: &mut SqliteConnection, args: GetMeetingArgs) -> Result<String, Problem> {
    let head = meeting_head(conn, &args.meeting_id).await?;
    let stats = meeting_stats(conn, std::slice::from_ref(&head.id)).await?;
    let stats = stats.get(&head.id);

    let contacts: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT p.id, p.display_name, group_concat(ps.speaker_label, ' | ') \
         FROM person_speakers ps JOIN people p ON p.id = ps.person_id \
         WHERE ps.meeting_id = ? GROUP BY p.id ORDER BY p.display_name COLLATE NOCASE",
    )
    .bind(&head.id)
    .fetch_all(&mut *conn)
    .await?;
    let labels: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT speaker, COUNT(*) FROM transcripts WHERE meeting_id = ? \
         GROUP BY speaker ORDER BY MIN(COALESCE(audio_start_time, 1e30))",
    )
    .bind(&head.id)
    .fetch_all(&mut *conn)
    .await?;
    let notes: Option<Option<String>> =
        sqlx::query_scalar("SELECT notes_markdown FROM meeting_notes WHERE meeting_id = ?")
            .bind(&head.id)
            .fetch_optional(&mut *conn)
            .await?;
    let summary_row = summary_row(conn, &head.id).await?;
    let actions = meeting_actions(conn, &head.id).await?;

    let mut out = Output::new();
    out.line(format!("# {}", one_line(&head.title)));
    let mut meta = vec![
        format!("id {}", head.id),
        format!("{} ({})", local_time(&head.created_at), local_offset()),
    ];
    if let Some(seconds) = stats.and_then(|stats| stats.seconds) {
        meta.push(text::duration(seconds));
    }
    if let Some((group_id, group_name)) = &head.group {
        meta.push(format!("group {} ({group_id})", quoted(group_name)));
    }
    out.line(meta.join(" · "));
    if !contacts.is_empty() {
        out.line(format!(
            "Contacts: {}",
            contacts
                .iter()
                .map(|(id, name, labels)| {
                    if labels == name {
                        format!("{name} ({id})")
                    } else {
                        format!("{name} ({id}; labelled {labels})")
                    }
                })
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !labels.is_empty() {
        out.line(format!(
            "Speaker labels in the transcript: {}",
            labels
                .iter()
                .map(|(label, count)| format!(
                    "{} ({count} lines)",
                    label.as_deref().filter(|label| !label.trim().is_empty()).unwrap_or("no label")
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        out.line(SPEAKER_NOTE);
    }

    if let Some(notes) = notes.flatten().map(|notes| notes.trim().to_string()).filter(|notes| !notes.is_empty()) {
        out.line("");
        out.line("## Your notes");
        out.line(text::clip(&notes, 1_500));
    }

    if !actions.is_empty() {
        out.line("");
        out.line("## Action items");
        let mut written = 0;
        for action in &actions {
            if !out.fit(action.render(false), 2_500) {
                break;
            }
            written += 1;
        }
        if written < actions.len() {
            out.line(format!(
                "{} more: get_action_items with meeting_id={} and offset={written}.",
                actions.len() - written,
                head.id
            ));
        }
    }

    out.line("");
    out.line("## AI summary");
    match &summary_row {
        Some(row) => {
            if let Some(status) = row.status_note() {
                out.line(status);
            }
            match row.markdown() {
                Some(markdown) => out.line(text::clip(&markdown, 3_500.min(out.room(FOOTER + 600)))),
                None => out.line("(no summary text)"),
            }
        }
        None => out.line("No summary has been generated for this meeting."),
    }

    let total_lines = stats.map_or(0, |stats| stats.lines as usize);
    out.line("");
    if total_lines == 0 {
        out.line("## Transcript");
        out.line("No transcript lines.");
    } else if args.include_transcript.unwrap_or(false) {
        let (lines, total) = transcript_lines(conn, &head.id, 0, 500).await?;
        let mut page = Output::with_budget(out.room(0));
        let written = write_lines(&mut page, &lines);
        out.line(format!("## Transcript ({})", range(0, written, total)));
        if written > 0 {
            out.line(page.finish());
        }
        if written < total {
            out.line(more_line("get_transcript", written, &format!(" (meeting_id={})", head.id)));
        }
    } else {
        out.line(format!(
            "## Transcript\n{total_lines} lines; read them with get_transcript (meeting_id={}).",
            head.id
        ));
    }
    Ok(out.finish())
}

pub async fn get_transcript(conn: &mut SqliteConnection, args: GetTranscriptArgs) -> Result<String, Problem> {
    let head = meeting_head(conn, &args.meeting_id).await?;
    let offset = args.offset.unwrap_or(0) as usize;
    let count = limit(args.limit, 200, 500);
    let (lines, total) = transcript_lines(conn, &head.id, offset, count).await?;

    let mut out = Output::new();
    let header_reserve = 120;
    let mut page = Output::with_budget(out.room(header_reserve));
    let written = write_lines(&mut page, &lines);
    out.line(format!(
        "Transcript of {} (id {}), lines {}. Times are positions in the recording.",
        quoted(&head.title),
        head.id,
        range(offset, written, total)
    ));
    out.line(SPEAKER_NOTE);
    if !page.is_empty() {
        out.line(page.finish());
    }
    if offset + written < total {
        out.line(more_line("get_transcript", offset + written, ""));
    }
    Ok(out.finish())
}

// ---------------------------------------------------------------------------
// get_summary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetSummaryArgs {
    /// The meeting's id, from list_meetings or search.
    pub meeting_id: String,
}

struct SummaryRow {
    status: String,
    result: Option<String>,
    error: Option<String>,
    updated_at: String,
    user_edited: bool,
}

impl SummaryRow {
    fn markdown(&self) -> Option<String> {
        self.result.as_deref().and_then(summary::summary_markdown)
    }

    /// The app keeps the previous summary in `result` while a new one is
    /// generated and puts it back when generating fails or is cancelled
    /// (repositories/summary.rs), so a status other than completed still
    /// comes with the text the user sees.
    fn status_note(&self) -> Option<String> {
        let edited = if self.user_edited { " The user edited it." } else { "" };
        let has_text = self.result.is_some();
        let reason = self.error.as_deref().unwrap_or("no reason given");
        match (self.status.as_str(), has_text) {
            ("completed", _) => (!edited.is_empty()).then(|| edited.trim().to_string()),
            ("PENDING", true) => Some(format!(
                "A new summary is being generated; this is the previous one.{edited}"
            )),
            ("PENDING", false) => Some("A summary is being generated.".to_string()),
            ("failed" | "cancelled", true) => Some(format!(
                "The last attempt to regenerate it {} ({reason}); this is the summary from before.{edited}",
                self.status
            )),
            ("failed" | "cancelled", false) => {
                Some(format!("Generating a summary {} ({reason}).", self.status))
            }
            (other, _) => Some(format!("Summary status: {other}.{edited}")),
        }
    }
}

async fn summary_row(conn: &mut SqliteConnection, meeting_id: &str) -> Result<Option<SummaryRow>, Problem> {
    let row: Option<(String, Option<String>, Option<String>, String, bool)> = sqlx::query_as(
        "SELECT s.status, s.result, s.error, s.updated_at, s.user_edited \
         FROM summary_processes s JOIN meetings m ON m.id = s.meeting_id WHERE s.meeting_id = ?",
    )
    .bind(meeting_id)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.map(|(status, result, error, updated_at, user_edited)| SummaryRow {
        status,
        result,
        error,
        updated_at,
        user_edited,
    }))
}

pub async fn get_summary(conn: &mut SqliteConnection, args: GetSummaryArgs) -> Result<String, Problem> {
    let head = meeting_head(conn, &args.meeting_id).await?;
    let row = summary_row(conn, &head.id).await?;
    let mut out = Output::new();
    out.line(format!(
        "AI summary of {} (id {}, {})",
        quoted(&head.title),
        head.id,
        local_time(&head.created_at)
    ));
    match row {
        None => out.line("No summary has been generated for this meeting."),
        Some(row) => {
            out.line(format!("Last updated {}.", local_time(&row.updated_at)));
            if let Some(status) = row.status_note() {
                out.line(status);
            }
            out.line("");
            match row.markdown() {
                Some(markdown) => out.line(text::clip(&markdown, out.room(20))),
                None => out.line("(no summary text)"),
            }
        }
    }
    Ok(out.finish())
}

// ---------------------------------------------------------------------------
// get_action_items
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetActionItemsArgs {
    /// One meeting's items, in their order. Without it, items across meetings, newest meeting first.
    pub meeting_id: Option<String>,
    /// Only items this contact owns: a person id from list_people, or a name.
    pub person: Option<String>,
    /// Only items from meetings filed in this group: a group id or name.
    pub group: Option<String>,
    /// Only items from meetings that started on or after this date (`YYYY-MM-DD` or RFC 3339).
    pub from: Option<String>,
    /// Only items from meetings that started on or before this date (`YYYY-MM-DD` or RFC 3339).
    pub to: Option<String>,
    /// "open" (not checked off), "done", or "all". Default "all" for one meeting, "open" otherwise.
    pub status: Option<String>,
    /// How many items to return. Default 50, at most 200.
    #[schemars(range(min = 1, max = 200))]
    pub limit: Option<u32>,
    /// How many items to skip; the result names the offset of the next page.
    pub offset: Option<u32>,
}

struct ActionItem {
    id: String,
    meeting_id: String,
    meeting_title: String,
    meeting_created_at: String,
    text: String,
    owner_label: Option<String>,
    person: Option<(String, String)>,
    due: Option<String>,
    done: bool,
}

impl ActionItem {
    fn render(&self, with_meeting: bool) -> String {
        let mut parts = vec![format!(
            "- [{}] {}",
            if self.done { 'x' } else { ' ' },
            one_line(&self.text)
        )];
        match (&self.person, &self.owner_label) {
            (Some((id, name)), _) => parts.push(format!("owner {name} ({id})")),
            (None, Some(label)) if !label.trim().is_empty() => parts.push(format!("owner {}", one_line(label))),
            _ => {}
        }
        if let Some(due) = self.due.as_deref().filter(|due| !due.trim().is_empty()) {
            parts.push(format!("due {}", one_line(due)));
        }
        if with_meeting {
            parts.push(format!(
                "meeting {} ({}, {})",
                quoted(&self.meeting_title),
                self.meeting_id,
                local_time(&self.meeting_created_at)
            ));
        }
        parts.push(format!("id {}", self.id));
        parts.join(" · ")
    }
}

type ActionRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
);

const ACTION_SELECT: &str = "SELECT a.id, a.meeting_id, m.title, m.created_at, a.text, a.owner_label, \
     p.id, p.display_name, a.due_text, a.done \
     FROM action_items a JOIN meetings m ON m.id = a.meeting_id \
     LEFT JOIN people p ON p.id = a.person_id";

fn action_from_row(row: ActionRow) -> ActionItem {
    let (id, meeting_id, meeting_title, meeting_created_at, text, owner_label, person_id, person_name, due, done) = row;
    ActionItem {
        id,
        meeting_id,
        meeting_title,
        meeting_created_at,
        text,
        owner_label,
        // A dangling person id (no FK enforcement in old databases) is no link.
        person: person_id.zip(person_name),
        due,
        done,
    }
}

async fn meeting_actions(conn: &mut SqliteConnection, meeting_id: &str) -> Result<Vec<ActionItem>, Problem> {
    let rows: Vec<ActionRow> = sqlx::query_as(&format!(
        "{ACTION_SELECT} WHERE a.meeting_id = ? ORDER BY a.position, a.created_at"
    ))
    .bind(meeting_id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().map(action_from_row).collect())
}

pub async fn get_action_items(conn: &mut SqliteConnection, args: GetActionItemsArgs) -> Result<String, Problem> {
    let page = limit(args.limit, 50, 200);
    let offset = args.offset.unwrap_or(0) as usize;
    let meeting = match clean(args.meeting_id) {
        Some(id) => Some(meeting_head(conn, &id).await?),
        None => None,
    };
    let status = clean(args.status).unwrap_or_else(|| {
        if meeting.is_some() { "all" } else { "open" }.to_string()
    });
    let status_clause = match status.to_ascii_lowercase().as_str() {
        "open" => " AND a.done = 0",
        "done" => " AND a.done = 1",
        "all" => "",
        other => {
            return Err(Problem::BadArgument(format!(
                "`status` must be \"open\", \"done\" or \"all\"; got {other:?}."
            )))
        }
    };

    // The person filter names the owner of an item, not a meeting participant.
    let person = clean(args.person);
    let scope = scope(conn, args.from, args.to, None, args.group).await?;
    if let Some(nothing) = scope.nothing {
        return Ok(nothing);
    }
    let mut notes = scope.notes;
    let mut binds = SqliteArguments::default();
    let mut condition = format!(" WHERE 1 = 1{status_clause}");
    if let Some(meeting) = &meeting {
        condition.push_str(" AND a.meeting_id = ?");
        let _ = binds.add(meeting.id.clone());
    }
    if let Some(person) = person {
        let people = named(conn, "people", "display_name", &person).await?;
        if people.is_empty() {
            return Ok(format!(
                "No contact matches {person:?}; list_people shows contacts. Items whose owner is \
                 not a contact keep the owner's name as written: search finds them."
            ));
        }
        notes.push(format!(
            "Owner {person:?} matched: {}.",
            people
                .iter()
                .map(|(id, name)| format!("{name} ({id})"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
        let ids: Vec<String> = people.into_iter().map(|(id, _)| id).collect();
        condition.push_str(&format!(" AND a.person_id IN ({})", search::placeholders(&ids, &mut binds)));
    }
    condition.push_str(&scope.filter.meeting_clauses(&mut binds));
    let order = if meeting.is_some() {
        "a.position, a.created_at"
    } else {
        "a.done, julianday(m.created_at) DESC, a.position"
    };

    let total: i64 = sqlx::query_scalar_with(
        &format!(
            "SELECT COUNT(*) FROM action_items a JOIN meetings m ON m.id = a.meeting_id{condition}"
        ),
        binds.clone(),
    )
    .fetch_one(&mut *conn)
    .await?;
    let mut page_args = binds;
    let _ = page_args.add(page as i64);
    let _ = page_args.add(offset as i64);
    let rows: Vec<ActionRow> = sqlx::query_as_with(
        &format!("{ACTION_SELECT}{condition} ORDER BY {order} LIMIT ? OFFSET ?"),
        page_args,
    )
    .fetch_all(&mut *conn)
    .await?;
    let items: Vec<ActionItem> = rows.into_iter().map(action_from_row).collect();

    let mut out = Output::new();
    let total = total as usize;
    let what = match status.to_ascii_lowercase().as_str() {
        "open" => "Open action items",
        "done" => "Done action items",
        _ => "Action items",
    };
    let header = match &meeting {
        Some(meeting) => format!("{what} of {} (id {})", quoted(&meeting.title), meeting.id),
        None => format!("{what} across meetings, newest meeting first"),
    };
    out.line(format!("{header}: {}.", range(offset, items.len(), total)));
    for note in &notes {
        out.line(note);
    }
    let mut shown = 0;
    for item in &items {
        if !out.fit(item.render(meeting.is_none()), FOOTER) {
            break;
        }
        shown += 1;
    }
    if offset + shown < total {
        out.line(more_line("get_action_items", offset + shown, ""));
    }
    Ok(out.finish())
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/// Deepest result a search pages to; past it the agent should narrow the query.
const SEARCH_WINDOW: usize = 200;

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    /// Words to find, as one phrase: the text must contain it, in any letter case. Words are matched as written, not by form: for a Russian word, search its stem.
    pub query: String,
    /// Kinds to return: any of "meeting" (title), "transcript" (a spoken line), "summary", "action" (action item), "person", "group". Default all.
    pub kinds: Option<Vec<String>>,
    /// Only meetings that started on or after this date (`YYYY-MM-DD` or RFC 3339). Date, person and group filters leave out person and group results.
    pub from: Option<String>,
    /// Only meetings that started on or before this date (`YYYY-MM-DD` or RFC 3339).
    pub to: Option<String>,
    /// Only meetings in which this contact spoke: a person id or name.
    pub person: Option<String>,
    /// Only meetings filed in this group: a group id or name.
    pub group: Option<String>,
    /// How many results to return, best first. Default 20, at most 50.
    #[schemars(range(min = 1, max = 50))]
    pub limit: Option<u32>,
    /// How many results to skip (up to 200 in all); the result names the offset of the next page.
    pub offset: Option<u32>,
}

pub async fn search(conn: &mut SqliteConnection, args: SearchArgs) -> Result<String, Problem> {
    let query = args.query.trim().to_string();
    if query.is_empty() {
        return Err(Problem::BadArgument("`query` must not be empty.".to_string()));
    }
    let page = limit(args.limit, 20, 50);
    let offset = args.offset.unwrap_or(0) as usize;
    if offset >= SEARCH_WINDOW {
        return Err(Problem::BadArgument(format!(
            "Search pages stop after {SEARCH_WINDOW} results. Narrow the query, or add from/to, \
             person, group or kinds."
        )));
    }
    let page = page.min(SEARCH_WINDOW - offset);
    let mut scope = scope(conn, args.from, args.to, args.person, args.group).await?;
    if let Some(nothing) = scope.nothing {
        return Ok(nothing);
    }
    if let Some(kinds) = args.kinds.filter(|kinds| !kinds.is_empty()) {
        let mut parsed = Vec::new();
        for kind in kinds {
            match Kind::parse(&kind) {
                Some(kind) => parsed.push(kind),
                None => {
                    return Err(Problem::BadArgument(format!(
                        "Unknown kind {kind:?}; use meeting, transcript, summary, action, person or group."
                    )))
                }
            }
        }
        scope.filter.kinds = Some(parsed);
    }

    let found = search::search(conn, &query, &scope.filter, offset, page).await?;
    let mut out = Output::new();
    out.line(format!(
        "Results for {} {}, best first. Times are local ({}).",
        quoted(&query),
        if found.results.is_empty() && offset == 0 {
            "none".to_string()
        } else {
            format!("{}–{}", offset + 1, offset + found.results.len())
        },
        local_offset()
    ));
    for note in &scope.notes {
        out.line(note);
    }
    let lines = line_numbers(conn, &found.results).await?;
    if !lines.is_empty() {
        out.line("Transcript lines count from 1, as get_transcript shows them; pass a result's offset to get_transcript to read around it.");
    }
    let mut shown = 0;
    for result in &found.results {
        if !out.fit(render_hit(result, &lines), FOOTER) {
            break;
        }
        shown += 1;
    }
    let more = found.more || shown < found.results.len();
    if more && offset + shown < SEARCH_WINDOW {
        out.line(more_line("search", offset + shown, ""));
    } else if more {
        out.line("More results exist; narrow the query or add filters to see them.");
    }
    Ok(out.finish())
}

/// Each transcript hit's zero-based line in its meeting, counted in
/// get_transcript's order, keyed by transcript id.
async fn line_numbers(
    conn: &mut SqliteConnection,
    hits: &[search::GlobalSearchResult],
) -> Result<std::collections::HashMap<String, i64>, Problem> {
    let transcript_hits: Vec<&search::GlobalSearchResult> =
        hits.iter().filter(|hit| hit.kind == "transcript").collect();
    let ids: Vec<String> = transcript_hits
        .iter()
        .filter_map(|hit| hit.transcript_id.clone())
        .collect();
    if ids.is_empty() {
        return Ok(Default::default());
    }
    let mut meetings: Vec<String> = transcript_hits
        .iter()
        .filter_map(|hit| hit.meeting_id.clone())
        .collect();
    meetings.sort();
    meetings.dedup();
    let mut binds = SqliteArguments::default();
    let meeting_marks = search::placeholders(&meetings, &mut binds);
    let id_marks = search::placeholders(&ids, &mut binds);
    let rows: Vec<(String, i64)> = sqlx::query_as_with(
        &format!(
            "SELECT id, line FROM ( \
                SELECT id, ROW_NUMBER() OVER ( \
                    PARTITION BY meeting_id ORDER BY audio_start_time, timestamp, id) - 1 AS line \
                FROM transcripts WHERE meeting_id IN ({meeting_marks})) \
             WHERE id IN ({id_marks})"
        ),
        binds,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows.into_iter().collect())
}

fn render_hit(hit: &search::GlobalSearchResult, lines: &std::collections::HashMap<String, i64>) -> String {
    let when = hit.timestamp.as_deref().map(local_time).unwrap_or_default();
    let meeting = |hit: &search::GlobalSearchResult| {
        format!(
            "meeting {} ({}, {when})",
            quoted(&hit.title),
            hit.meeting_id.as_deref().unwrap_or("?")
        )
    };
    match hit.kind.as_str() {
        "transcript" => {
            let at = hit.audio_start_time.map(|time| format!(" at {}", clock(time))).unwrap_or_default();
            let at = match hit.transcript_id.as_ref().and_then(|id| lines.get(id)) {
                Some(line) => format!("{at}, line {}, offset {line}", line + 1),
                None => at,
            };
            let speaker = hit
                .speaker
                .as_deref()
                .filter(|speaker| !speaker.trim().is_empty())
                .map(|speaker| format!("{speaker}: "))
                .unwrap_or_default();
            format!("- transcript · {}{at} · {speaker}{}", meeting(hit), quoted(&hit.snippet))
        }
        "summary" => format!("- summary · {} · {}", meeting(hit), quoted(&hit.snippet)),
        "meeting" => format!("- meeting {} · id {} · {when}", quoted(&hit.title), hit.id),
        "action" => {
            let owner = hit
                .speaker
                .as_deref()
                .filter(|owner| !owner.trim().is_empty())
                .map(|owner| format!(" · owner {owner}"))
                .unwrap_or_default();
            format!("- action item {}{owner} · {} · id {}", quoted(&hit.snippet), meeting(hit), hit.id)
        }
        // Ctrl+K shows a person's notes as the snippet; agents never get them (#8, v1).
        // No meeting count: Ctrl+K's also counts a deleted meeting's leftover
        // speaker links; list_people counts only meetings that exist.
        "person" => format!("- person {} · id {}", one_line(&hit.title), hit.id),
        "group" => format!(
            "- group {} · id {} · {}",
            quoted(&hit.title),
            hit.id,
            hit.snippet
        ),
        other => format!("- {other} · {} · {}", quoted(&hit.title), quoted(&hit.snippet)),
    }
}

// ---------------------------------------------------------------------------
// list_people / list_groups
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListPeopleArgs {
    /// Only contacts whose name contains this text.
    pub name: Option<String>,
    /// How many contacts to return, by name. Default 50, at most 200.
    #[schemars(range(min = 1, max = 200))]
    pub limit: Option<u32>,
    /// How many contacts to skip; the result names the offset of the next page.
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListGroupsArgs {
    /// Only groups whose name contains this text.
    pub name: Option<String>,
    /// How many groups to return, by name. Default 50, at most 200.
    #[schemars(range(min = 1, max = 200))]
    pub limit: Option<u32>,
    /// How many groups to skip; the result names the offset of the next page.
    pub offset: Option<u32>,
}

fn name_condition(name: Option<String>, binds: &mut Vec<String>, column: &str) -> String {
    match clean(name) {
        Some(name) => {
            binds.push(format!("%{}%", escape_like(&normalize_person_name(&name))));
            format!(" WHERE {column} LIKE ? ESCAPE '\\'")
        }
        None => String::new(),
    }
}

pub async fn list_people(conn: &mut SqliteConnection, args: ListPeopleArgs) -> Result<String, Problem> {
    let page = limit(args.limit, 50, 200);
    let offset = args.offset.unwrap_or(0) as usize;
    let mut binds = Vec::new();
    let condition = name_condition(args.name, &mut binds, "p.normalized_name");
    let total: i64 = sqlx::query_scalar_with(&format!("SELECT COUNT(*) FROM people p{condition}"), arguments(&binds))
        .fetch_one(&mut *conn)
        .await?;
    let mut page_args = arguments(&binds);
    let _ = page_args.add(page as i64);
    let _ = page_args.add(offset as i64);
    // Phone numbers and the user's notes about a person stay out (#8, v1).
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, i64, Option<String>)> =
        sqlx::query_as_with(
            &format!(
                "SELECT p.id, p.display_name, p.email, p.company, p.role, \
                        COUNT(DISTINCT m.id), MAX(m.created_at) \
                 FROM people p \
                 LEFT JOIN person_speakers ps ON ps.person_id = p.id \
                 LEFT JOIN meetings m ON m.id = ps.meeting_id{condition} \
                 GROUP BY p.id ORDER BY p.display_name COLLATE NOCASE, p.id LIMIT ? OFFSET ?"
            ),
            page_args,
        )
        .fetch_all(&mut *conn)
        .await?;
    let ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let mut groups: std::collections::HashMap<String, Vec<String>> = Default::default();
    if !ids.is_empty() {
        let marks = vec!["?"; ids.len()].join(", ");
        let group_rows: Vec<(String, String, String, i64)> = sqlx::query_as_with(
            &format!(
                "SELECT ps.person_id, g.id, g.name, COUNT(DISTINCT m.id) \
                 FROM person_speakers ps \
                 JOIN meetings m ON m.id = ps.meeting_id \
                 JOIN groups g ON g.id = m.group_id \
                 WHERE ps.person_id IN ({marks}) \
                 GROUP BY ps.person_id, g.id ORDER BY COUNT(DISTINCT m.id) DESC, g.name COLLATE NOCASE"
            ),
            arguments(&ids),
        )
        .fetch_all(&mut *conn)
        .await?;
        for (person, id, name, count) in group_rows {
            groups
                .entry(person)
                .or_default()
                .push(format!("{} ({id}, {count})", quoted(&name)));
        }
    }

    let mut out = Output::new();
    let total = total as usize;
    out.line(format!(
        "Contacts {}, by name. Contacts are the names given to speakers in Protocol.",
        range(offset, rows.len(), total)
    ));
    let mut shown = 0;
    for (id, name, email, company, role, meetings, last) in &rows {
        let mut parts = vec![format!("- {}", one_line(name)), format!("id {id}")];
        for value in [email, company, role].into_iter().flatten() {
            if !value.trim().is_empty() {
                parts.push(one_line(value));
            }
        }
        parts.push(match last {
            Some(last) if *meetings > 0 => format!("{}, last {}", text::count(*meetings, "meeting"), local_time(last)),
            _ => "no meetings".to_string(),
        });
        if let Some(groups) = groups.get(id) {
            parts.push(format!("groups: {}", groups.join(", ")));
        }
        if !out.fit(parts.join(" · "), FOOTER) {
            break;
        }
        shown += 1;
    }
    if offset + shown < total {
        out.line(more_line("list_people", offset + shown, ""));
    }
    Ok(out.finish())
}

pub async fn list_groups(conn: &mut SqliteConnection, args: ListGroupsArgs) -> Result<String, Problem> {
    let page = limit(args.limit, 50, 200);
    let offset = args.offset.unwrap_or(0) as usize;
    let mut binds = Vec::new();
    let condition = name_condition(args.name, &mut binds, "g.normalized_name");
    let total: i64 = sqlx::query_scalar_with(&format!("SELECT COUNT(*) FROM groups g{condition}"), arguments(&binds))
        .fetch_one(&mut *conn)
        .await?;
    let mut page_args = arguments(&binds);
    let _ = page_args.add(page as i64);
    let _ = page_args.add(offset as i64);
    let rows: Vec<(String, String, Option<String>, Option<String>, i64, Option<String>)> = sqlx::query_as_with(
        &format!(
            "SELECT g.id, g.name, g.kind, g.description, \
                    (SELECT COUNT(*) FROM meetings m WHERE m.group_id = g.id), \
                    (SELECT m.created_at FROM meetings m WHERE m.group_id = g.id \
                     ORDER BY julianday(m.created_at) DESC LIMIT 1) \
             FROM groups g{condition} ORDER BY g.name COLLATE NOCASE, g.id LIMIT ? OFFSET ?"
        ),
        page_args,
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut out = Output::new();
    let total = total as usize;
    out.line(format!("Groups {}, by name.", range(offset, rows.len(), total)));
    let mut shown = 0;
    for (id, name, kind, description, meetings, last) in &rows {
        let mut parts = vec![format!("- {}", quoted(name)), format!("id {id}")];
        if let Some(kind) = kind.as_deref().filter(|kind| !kind.trim().is_empty()) {
            parts.push(one_line(kind));
        }
        parts.push(match last {
            Some(last) => format!("{}, last {}", text::count(*meetings, "meeting"), local_time(last)),
            None => "no meetings".to_string(),
        });
        if let Some(description) = description.as_deref().filter(|text| !text.trim().is_empty()) {
            parts.push(text::clip(&one_line(description), 120));
        }
        if !out.fit(parts.join(" · "), FOOTER) {
            break;
        }
        shown += 1;
    }
    if offset + shown < total {
        out.line(more_line("list_groups", offset + shown, ""));
    }
    Ok(out.finish())
}
