//! The library search behind Ctrl+K (`api_global_search`) and the MCP server's
//! `search` tool: one ranked list of people, meetings, transcript lines,
//! summaries, groups and action items whose text contains the query.
//!
//! Moved here from the app's `person.rs` (#8) so both callers run the same
//! queries. With an empty [`SearchFilter`] the queries and the ranking are the
//! ones Ctrl+K has always used; `global_search_tests.rs` in the app pins them.

use serde::Serialize;
use sqlx::sqlite::SqliteArguments;
use sqlx::{Arguments, SqliteConnection};
use std::cmp::Ordering;

use crate::normalize_person_name;
use crate::summary::visible_summary_text;

const DEFAULT_SEARCH_LIMIT: i64 = 40;
const MAX_SEARCH_LIMIT: i64 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSearchResult {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub person_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_id: Option<String>,
    pub title: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_start_time: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meeting_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

/// The `kind` values of [`GlobalSearchResult`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Person,
    Meeting,
    Transcript,
    Summary,
    Group,
    Action,
}

impl Kind {
    pub const ALL: [Kind; 6] = [
        Kind::Person,
        Kind::Meeting,
        Kind::Transcript,
        Kind::Summary,
        Kind::Group,
        Kind::Action,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Person => "person",
            Kind::Meeting => "meeting",
            Kind::Transcript => "transcript",
            Kind::Summary => "summary",
            Kind::Group => "group",
            Kind::Action => "action",
        }
    }

    pub fn parse(value: &str) -> Option<Kind> {
        Kind::ALL
            .into_iter()
            .find(|kind| kind.as_str().eq_ignore_ascii_case(value.trim()))
    }

    /// Kinds whose rows belong to one meeting, so meeting filters apply to them.
    fn in_meeting(self) -> bool {
        !matches!(self, Kind::Person | Kind::Group)
    }
}

/// Narrows a search to some kinds and to meetings by date, group or person.
/// Meeting filters drop person and group results, which belong to no meeting.
#[derive(Debug, Clone, Default)]
pub struct SearchFilter {
    /// `None` searches every kind.
    pub kinds: Option<Vec<Kind>>,
    /// Meetings that started at or after this instant, in a form SQLite's
    /// `julianday` reads (RFC 3339).
    pub from: Option<String>,
    /// Meetings that started at or before this instant (RFC 3339).
    pub to: Option<String>,
    /// Meetings filed in any of these groups.
    pub group_ids: Option<Vec<String>>,
    /// Meetings in which any of these people spoke (`person_speakers`).
    pub person_ids: Option<Vec<String>>,
}

impl SearchFilter {
    fn has_meeting_scope(&self) -> bool {
        self.from.is_some()
            || self.to.is_some()
            || self.group_ids.is_some()
            || self.person_ids.is_some()
    }

    fn includes(&self, kind: Kind) -> bool {
        if self.has_meeting_scope() && !kind.in_meeting() {
            return false;
        }
        self.kinds
            .as_ref()
            .map_or(true, |kinds| kinds.contains(&kind))
    }

    /// ` AND ...` conditions on the meeting aliased `m`, with their arguments.
    fn meeting_clauses(&self, args: &mut SqliteArguments<'_>) -> String {
        let mut sql = String::new();
        if let Some(from) = &self.from {
            sql.push_str(" AND julianday(m.created_at) >= julianday(?)");
            let _ = args.add(from.clone());
        }
        if let Some(to) = &self.to {
            sql.push_str(" AND julianday(m.created_at) <= julianday(?)");
            let _ = args.add(to.clone());
        }
        if let Some(group_ids) = &self.group_ids {
            sql.push_str(&format!(" AND m.group_id IN ({})", placeholders(group_ids, args)));
        }
        if let Some(person_ids) = &self.person_ids {
            sql.push_str(&format!(
                " AND EXISTS (SELECT 1 FROM person_speakers fps \
                 WHERE fps.meeting_id = m.id AND fps.person_id IN ({}))",
                placeholders(person_ids, args)
            ));
        }
        sql
    }
}

/// `?, ?, ...` for `ids`, bound in order. An empty list matches nothing (not
/// every meeting), so a filter whose name matched no row returns no results.
pub fn placeholders(ids: &[String], args: &mut SqliteArguments<'_>) -> String {
    if ids.is_empty() {
        let _ = args.add(String::new());
        return "?".to_string();
    }
    for id in ids {
        let _ = args.add(id.clone());
    }
    vec!["?"; ids.len()].join(", ")
}

/// One page of [`search`] results.
#[derive(Debug, Clone)]
pub struct SearchPage {
    pub results: Vec<GlobalSearchResult>,
    /// More results follow this page.
    pub more: bool,
}

#[derive(Debug)]
struct RankedResult {
    score: i32,
    sort_time: String,
    result: GlobalSearchResult,
}

/// The Ctrl+K search: at most `limit` results (default 40, at most 100).
pub async fn global_search(
    conn: &mut SqliteConnection,
    query: &str,
    limit: Option<i64>,
) -> Result<Vec<GlobalSearchResult>, sqlx::Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let limit = limit
        .unwrap_or(DEFAULT_SEARCH_LIMIT)
        .clamp(1, MAX_SEARCH_LIMIT);
    let mut ranked = ranked(conn, query, limit, &SearchFilter::default()).await?;
    ranked.truncate(limit as usize);
    Ok(ranked.into_iter().map(|item| item.result).collect())
}

/// Results `offset..offset + limit` of the ranked list for `query` within
/// `filter`. Each kind is asked for `offset + limit + 1` rows, so the merged
/// list is exact up to the end of this page and `more` is known.
pub async fn search(
    conn: &mut SqliteConnection,
    query: &str,
    filter: &SearchFilter,
    offset: usize,
    limit: usize,
) -> Result<SearchPage, sqlx::Error> {
    let query = query.trim();
    if query.is_empty() || limit == 0 {
        return Ok(SearchPage {
            results: Vec::new(),
            more: false,
        });
    }
    let fetch = (offset + limit + 1) as i64;
    let ranked = ranked(conn, query, fetch, filter).await?;
    let more = ranked.len() > offset + limit;
    Ok(SearchPage {
        results: ranked
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|item| item.result)
            .collect(),
        more,
    })
}

/// Every matching row of each kind (at most `fetch` per kind except
/// summaries, whose visible text is matched in Rust), best first.
async fn ranked(
    conn: &mut SqliteConnection,
    query: &str,
    fetch: i64,
    filter: &SearchFilter,
) -> Result<Vec<RankedResult>, sqlx::Error> {
    let normalized_query = normalize_person_name(query);
    let like_query = format!("%{}%", escape_like(&normalized_query));
    let mut ranked = Vec::new();

    if filter.includes(Kind::Person) {
        let people = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
            "SELECT p.id, p.display_name, p.notes, COUNT(DISTINCT ps.meeting_id) \
             FROM people p \
             LEFT JOIN person_speakers ps ON ps.person_id = p.id \
             WHERE p.normalized_name LIKE ? ESCAPE '\\' \
             GROUP BY p.id, p.display_name, p.notes, p.updated_at \
             ORDER BY p.updated_at DESC LIMIT ?",
        )
        .bind(&like_query)
        .bind(fetch)
        .fetch_all(&mut *conn)
        .await?;

        for (id, display_name, notes, meeting_count) in people {
            let score = match_quality(&normalize_person_name(&display_name), &normalized_query);
            ranked.push(RankedResult {
                score,
                sort_time: String::new(),
                result: GlobalSearchResult {
                    kind: "person".to_string(),
                    id: id.clone(),
                    meeting_id: None,
                    person_id: Some(id),
                    transcript_id: None,
                    title: display_name,
                    snippet: notes.unwrap_or_else(|| format!("{} mapped meetings", meeting_count)),
                    timestamp: None,
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: Some(meeting_count),
                    group_id: None,
                    color: None,
                },
            });
        }
    }

    if filter.includes(Kind::Meeting) {
        let mut args = SqliteArguments::default();
        let _ = args.add(like_query.clone());
        let scope = filter.meeting_clauses(&mut args);
        let _ = args.add(fetch);
        let meetings = sqlx::query_as_with::<_, (String, String, String), _>(
            &format!(
                "SELECT m.id, m.title, m.created_at FROM meetings m \
                 WHERE lower(m.title) LIKE ? ESCAPE '\\'{scope} \
                 ORDER BY m.created_at DESC LIMIT ?"
            ),
            args,
        )
        .fetch_all(&mut *conn)
        .await?;

        for (id, title, created_at) in meetings {
            ranked.push(RankedResult {
                score: match_quality(&title.to_lowercase(), &normalized_query),
                sort_time: created_at.clone(),
                result: GlobalSearchResult {
                    kind: "meeting".to_string(),
                    id: id.clone(),
                    meeting_id: Some(id),
                    person_id: None,
                    transcript_id: None,
                    title: title.clone(),
                    snippet: title,
                    timestamp: Some(created_at),
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: None,
                    group_id: None,
                    color: None,
                },
            });
        }
    }

    if filter.includes(Kind::Transcript) {
        let mut args = SqliteArguments::default();
        let _ = args.add(like_query.clone());
        let _ = args.add(like_query.clone());
        let scope = filter.meeting_clauses(&mut args);
        let _ = args.add(fetch);
        let transcripts = sqlx::query_as_with::<
            _,
            (
                String,
                String,
                String,
                String,
                String,
                Option<String>,
                Option<f64>,
            ),
            _,
        >(
            &format!(
                "SELECT t.id, m.id, m.title, t.transcript, t.timestamp, t.speaker, t.audio_start_time \
                 FROM transcripts t JOIN meetings m ON m.id = t.meeting_id \
                 WHERE (lower(t.transcript) LIKE ? ESCAPE '\\' \
                    OR lower(COALESCE(t.speaker, '')) LIKE ? ESCAPE '\\'){scope} \
                 ORDER BY m.created_at DESC, t.audio_start_time ASC LIMIT ?"
            ),
            args,
        )
        .fetch_all(&mut *conn)
        .await?;

        for (id, meeting_id, title, text, timestamp, speaker, audio_start_time) in transcripts {
            let speaker_match = speaker
                .as_deref()
                .map(|value| value.to_lowercase().contains(&normalized_query))
                .unwrap_or(false);
            ranked.push(RankedResult {
                score: if speaker_match { 5 } else { 20 },
                sort_time: timestamp.clone(),
                result: GlobalSearchResult {
                    kind: "transcript".to_string(),
                    id: id.clone(),
                    meeting_id: Some(meeting_id),
                    person_id: None,
                    transcript_id: Some(id),
                    title,
                    snippet: snippet_around(&text, query, 180),
                    timestamp: Some(timestamp),
                    speaker,
                    audio_start_time,
                    meeting_count: None,
                    group_id: None,
                    color: None,
                },
            });
        }
    }

    if filter.includes(Kind::Summary) {
        // Summary JSON contains caches and editor structure, so only parsed,
        // user-visible text is searched. Never use a LIKE against the raw blob.
        let mut args = SqliteArguments::default();
        let scope = filter.meeting_clauses(&mut args);
        let summaries = sqlx::query_as_with::<_, (String, String, String, String), _>(
            &format!(
                "SELECT m.id, m.title, m.created_at, s.result \
                 FROM summary_processes s JOIN meetings m ON m.id = s.meeting_id \
                 WHERE s.result IS NOT NULL{scope} ORDER BY m.created_at DESC"
            ),
            args,
        )
        .fetch_all(&mut *conn)
        .await?;

        for (meeting_id, title, created_at, raw) in summaries {
            let Some(visible) = visible_summary_text(&raw) else {
                continue;
            };
            if !visible.to_lowercase().contains(&normalized_query) {
                continue;
            }
            ranked.push(RankedResult {
                score: 25,
                sort_time: created_at.clone(),
                result: GlobalSearchResult {
                    kind: "summary".to_string(),
                    id: format!("summary-{}", meeting_id),
                    meeting_id: Some(meeting_id),
                    person_id: None,
                    transcript_id: None,
                    title,
                    snippet: snippet_around(&visible, query, 220),
                    timestamp: Some(created_at),
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: None,
                    group_id: None,
                    color: None,
                },
            });
        }
    }

    if filter.includes(Kind::Group) {
        let groups = sqlx::query_as::<_, (String, String, Option<String>, i64)>(
            "SELECT g.id, g.name, g.color, (SELECT COUNT(*) FROM meetings m WHERE m.group_id = g.id) \
             FROM groups g WHERE g.normalized_name LIKE ? ESCAPE '\\' LIMIT ?",
        )
        .bind(&like_query)
        .bind(fetch)
        .fetch_all(&mut *conn)
        .await?;

        for (id, name, color, meeting_count) in groups {
            ranked.push(RankedResult {
                score: match_quality(&normalize_person_name(&name), &normalized_query) + 1,
                sort_time: String::new(),
                result: GlobalSearchResult {
                    kind: "group".to_string(),
                    id: id.clone(),
                    meeting_id: None,
                    person_id: None,
                    transcript_id: None,
                    title: name,
                    snippet: format!(
                        "{} meeting{}",
                        meeting_count,
                        if meeting_count == 1 { "" } else { "s" }
                    ),
                    timestamp: None,
                    speaker: None,
                    audio_start_time: None,
                    meeting_count: Some(meeting_count),
                    group_id: Some(id),
                    color,
                },
            });
        }
    }

    if filter.includes(Kind::Action) {
        let mut args = SqliteArguments::default();
        let _ = args.add(like_query.clone());
        let _ = args.add(like_query.clone());
        let scope = filter.meeting_clauses(&mut args);
        let _ = args.add(fetch);
        let actions = sqlx::query_as_with::<
            _,
            (String, String, String, String, String, Option<String>, Option<f64>),
            _,
        >(
            &format!(
                "SELECT a.id, a.meeting_id, m.title, m.created_at, a.text, a.owner_label, a.audio_time \
                 FROM action_items a JOIN meetings m ON m.id = a.meeting_id \
                 WHERE (lower(a.text) LIKE ? ESCAPE '\\' OR lower(COALESCE(a.owner_label, '')) LIKE ? ESCAPE '\\'){scope} \
                 ORDER BY a.done, m.created_at DESC LIMIT ?"
            ),
            args,
        )
        .fetch_all(&mut *conn)
        .await?;

        for (id, meeting_id, title, created_at, text, owner, audio_time) in actions {
            ranked.push(RankedResult {
                score: 18,
                sort_time: created_at.clone(),
                result: GlobalSearchResult {
                    kind: "action".to_string(),
                    id,
                    meeting_id: Some(meeting_id),
                    person_id: None,
                    transcript_id: None,
                    title,
                    snippet: text,
                    timestamp: Some(created_at),
                    speaker: owner,
                    audio_start_time: audio_time,
                    meeting_count: None,
                    group_id: None,
                    color: None,
                },
            });
        }
    }

    ranked.sort_by(|a, b| {
        a.score
            .cmp(&b.score)
            .then_with(|| b.sort_time.cmp(&a.sort_time))
            .then_with(|| a.result.id.cmp(&b.result.id))
    });
    Ok(ranked)
}

/// Escapes LIKE wildcards for `ESCAPE '\'`.
pub fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn match_quality(value: &str, query: &str) -> i32 {
    match value.cmp(query) {
        Ordering::Equal => 0,
        _ if value.starts_with(query) => 3,
        _ => 10,
    }
}

fn snippet_around(text: &str, query: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        return text.to_string();
    }

    let lower = text.to_lowercase();
    let query_lower = query.to_lowercase();
    let match_char = lower
        .find(&query_lower)
        .map(|byte| lower[..byte].chars().count())
        .unwrap_or(0)
        .min(chars.len());
    let start = match_char.saturating_sub(max_chars / 3);
    let end = (start + max_chars).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet.insert_str(0, "...");
    }
    if end < chars.len() {
        snippet.push_str("...");
    }
    snippet
}
