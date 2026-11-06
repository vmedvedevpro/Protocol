//! Tool results as compact text, sized for the agent's context.
//!
//! Claude Code warns when one MCP result passes 10,000 tokens and moves
//! results over 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`) or 50,000 characters
//! to a file. A result here stays under [`RESULT_TOKENS`] by an estimate that
//! errs high for Russian: Cyrillic takes several times more tokens per
//! character than English. Results are plain text only, without
//! `structuredContent`, so the model never receives the same rows twice.

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};

/// Upper bound on one result's estimated tokens, below the 10,000-token warning.
pub const RESULT_TOKENS: usize = 8_000;
/// Upper bound on one result's characters. Claude Code saves a result longer
/// than 50,000 characters to a file instead of showing it; at 3 ASCII
/// characters per token the token budget alone would allow 24,000.
pub const RESULT_CHARS: usize = 40_000;

/// Estimated tokens: ASCII at 3 characters per token, anything else (Cyrillic,
/// accents, CJK) at 0.6 tokens per character. Both are pessimistic for prose,
/// so a page that fits here fits the client's limits.
pub fn estimated_tokens(text: &str) -> usize {
    let (ascii, other) = text.chars().fold((0usize, 0usize), |(ascii, other), c| {
        if c.is_ascii() {
            (ascii + 1, other)
        } else {
            (ascii, other + 1)
        }
    });
    ascii.div_ceil(3) + (other * 3).div_ceil(5)
}

/// A result being written within a token budget.
pub struct Output {
    text: String,
    tokens: usize,
    chars: usize,
    budget: usize,
}

impl Output {
    pub fn new() -> Self {
        Self::with_budget(RESULT_TOKENS)
    }

    pub fn with_budget(budget: usize) -> Self {
        Output {
            text: String::new(),
            tokens: 0,
            chars: 0,
            budget,
        }
    }

    /// Appends a line whatever it costs (headers, notices).
    pub fn line(&mut self, line: impl AsRef<str>) {
        let line = line.as_ref();
        self.tokens += estimated_tokens(line) + 1;
        self.chars += line.chars().count() + 1;
        self.text.push_str(line);
        self.text.push('\n');
    }

    /// Appends `line` if it fits and keeps `reserve` tokens free for what must
    /// follow (the paging line). Returns false, appending nothing, otherwise.
    pub fn fit(&mut self, line: impl AsRef<str>, reserve: usize) -> bool {
        let line = line.as_ref();
        let cost = estimated_tokens(line) + 1;
        // `reserve` tokens are at most 3 * reserve characters.
        let chars = line.chars().count() + 1 + 3 * reserve;
        if self.tokens + cost + reserve > self.budget || self.chars + chars > RESULT_CHARS {
            return false;
        }
        self.line(line);
        true
    }

    /// Writes a list: `header(shown)` and `notes`, then as many `rows` as fit
    /// with `reserve` tokens kept free below them (the paging line). The rows
    /// are fitted first, so the header counts only those written. Returns how
    /// many were.
    pub fn list(
        &mut self,
        header: impl Fn(usize) -> String,
        notes: &[String],
        rows: &[String],
        reserve: usize,
    ) -> usize {
        // The header's longest form: its count has at most as many digits as
        // for every row, and "none of N" is the form for no row.
        let header_tokens = estimated_tokens(&header(rows.len())).max(estimated_tokens(&header(0))) + 1;
        let notes_tokens: usize = notes.iter().map(|note| estimated_tokens(note) + 1).sum();
        let mut page = Output::with_budget(self.room(header_tokens + notes_tokens + reserve));
        let mut shown = 0;
        for row in rows {
            if !page.fit(row, 0) {
                break;
            }
            shown += 1;
        }
        self.line(header(shown));
        for note in notes {
            self.line(note);
        }
        if !page.is_empty() {
            self.line(page.finish());
        }
        shown
    }

    /// Tokens still free after keeping `reserve`.
    pub fn room(&self, reserve: usize) -> usize {
        self.budget.saturating_sub(self.tokens + reserve)
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn finish(self) -> String {
        self.text.trim_end().to_string()
    }
}

/// `text` cut to about `tokens` estimated tokens, with a note of what was cut.
pub fn clip(text: &str, tokens: usize) -> String {
    if estimated_tokens(text) <= tokens {
        return text.to_string();
    }
    // In fifteenths of a token: ASCII 5 (1/3), anything else 9 (0.6), as in
    // `estimated_tokens`; 16 tokens stay free for the note.
    let limit = tokens.saturating_sub(16) * 15;
    let mut kept = String::new();
    let mut used = 0;
    for c in text.chars() {
        let cost = if c.is_ascii() { 5 } else { 9 };
        if used + cost > limit {
            break;
        }
        used += cost;
        kept.push(c);
    }
    let rest = text.chars().count() - kept.chars().count();
    format!("{kept}… [{rest} more characters cut to fit]")
}

/// A stored timestamp as an instant. The app writes RFC 3339 (with an offset
/// or `Z`) and, in older rows, `YYYY-MM-DD HH:MM:SS` in UTC.
pub fn parse_stored_time(value: &str) -> Option<DateTime<Utc>> {
    let value = value.trim();
    if let Ok(time) = DateTime::parse_from_rfc3339(value) {
        return Some(time.with_timezone(&Utc));
    }
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(value, format) {
            return Some(Utc.from_utc_datetime(&naive));
        }
    }
    None
}

/// A stored timestamp in this computer's local time, `2026-10-01 12:00`.
pub fn local_time(value: &str) -> String {
    match parse_stored_time(value) {
        Some(time) => time.with_timezone(&Local).format("%Y-%m-%d %H:%M").to_string(),
        None => value.to_string(),
    }
}

/// `UTC+03:00`, the offset local times are given in.
pub fn local_offset() -> String {
    format!("UTC{}", Local::now().format("%:z"))
}

/// A recording position as the transcript and the Markdown export show it.
pub fn clock(seconds: f64) -> String {
    let total = seconds.max(0.0).floor() as u64;
    let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes:02}:{secs:02}")
    }
}

pub fn duration(seconds: f64) -> String {
    let minutes = (seconds / 60.0).round() as u64;
    if minutes < 60 {
        format!("{} min", minutes.max(1))
    } else {
        format!("{} h {:02} min", minutes / 60, minutes % 60)
    }
}

/// `"from–to"` of the rows `offset..offset + shown` of `total`, one-based.
pub fn range(offset: usize, shown: usize, total: usize) -> String {
    if shown == 0 {
        return format!("none of {total}");
    }
    format!("{}–{} of {}", offset + 1, offset + shown, total)
}

/// `1 meeting`, `2 meetings`.
pub fn count(n: i64, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

/// A quoted title for one line of text.
pub fn quoted(title: &str) -> String {
    format!("\"{}\"", one_line(title))
}

pub fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cyrillic_counts_more_than_ascii() {
        assert_eq!(estimated_tokens("abcdef"), 2);
        assert_eq!(estimated_tokens("привет"), 4);
        assert_eq!(estimated_tokens(""), 0);
    }

    #[test]
    fn output_keeps_its_reserve() {
        let mut out = Output::with_budget(20);
        assert!(out.fit("a".repeat(30), 5)); // 10 + 1
        assert!(!out.fit("b".repeat(30), 5)); // 22 > 20 - 5
        out.line("paging");
        assert!(out.finish().ends_with("paging"));
    }

    #[test]
    fn clipping_marks_what_was_cut() {
        let long = "слово ".repeat(5_000);
        let clipped = clip(&long, 1_000);
        assert!(estimated_tokens(&clipped) <= 1_000);
        assert!(clipped.contains("more characters cut to fit"));
        assert_eq!(clip("short", 1_000), "short");
    }

    #[test]
    fn stored_times_in_every_format_the_app_wrote() {
        let expected = Utc.with_ymd_and_hms(2026, 10, 1, 9, 0, 0).unwrap();
        for value in [
            "2026-10-01T09:00:00+00:00",
            "2026-10-01T12:00:00+03:00",
            "2026-10-01T09:00:00Z",
            "2026-10-01T09:00:00.000000+00:00",
            "2026-10-01 09:00:00",
            "2026-10-01T09:00:00",
        ] {
            assert_eq!(parse_stored_time(value), Some(expected), "{value}");
        }
        assert_eq!(local_time("not a time"), "not a time");
    }

    #[test]
    fn clocks_and_durations() {
        assert_eq!(clock(12.9), "00:12");
        assert_eq!(clock(3_725.0), "1:02:05");
        assert_eq!(duration(20.0), "1 min");
        assert_eq!(duration(3_130.0), "52 min");
        assert_eq!(duration(3_900.0), "1 h 05 min");
        assert_eq!(range(0, 20, 57), "1–20 of 57");
        assert_eq!(range(40, 0, 40), "none of 40");
    }
}
