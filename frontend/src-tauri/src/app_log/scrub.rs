//! What the log hides: secrets as each line is written, and the home folder
//! and user name in the copy Save logs makes.
//!
//! Meeting content is kept out at the call sites instead (the audit in
//! `scripts/log-audit/`): a pattern cannot tell a transcript from any other
//! text. The secret patterns here are a second line behind that audit, for a
//! key that reaches a line through an error message or a URL.

use once_cell::sync::Lazy;
use regex::Regex;
use std::borrow::Cow;

const HIDDEN: &str = "<redacted>";

static PROVIDER_KEY: Lazy<Regex> = Lazy::new(|| {
    // OpenAI, Anthropic (`sk-ant-`), OpenRouter (`sk-or-`) and Groq (`gsk_`) keys.
    Regex::new(r"\b(sk-|gsk_)[A-Za-z0-9_\-]{16,}").unwrap()
});
static BEARER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}").unwrap());
static NAMED_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b(api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(\s*["']?\s*[:=]\s*["']?)[^\s"',;&}]+"#,
    )
    .unwrap()
});

/// `line` with API keys, bearer tokens and `key=value` secrets replaced.
pub fn secrets(line: &str) -> Cow<'_, str> {
    let mut text = Cow::Borrowed(line);
    if PROVIDER_KEY.is_match(&text) {
        text = Cow::Owned(PROVIDER_KEY.replace_all(&text, "${1}<redacted>").into_owned());
    }
    if BEARER.is_match(&text) {
        text = Cow::Owned(BEARER.replace_all(&text, "Bearer <redacted>").into_owned());
    }
    if NAMED_SECRET.is_match(&text) {
        text = Cow::Owned(
            NAMED_SECRET
                .replace_all(&text, format!("${{1}}${{2}}{HIDDEN}").as_str())
                .into_owned(),
        );
    }
    text
}

/// Rewrites the home folder as `~` and the user name as `<user>`, for files
/// a tester sends.
#[derive(Clone, Debug)]
pub struct Identity {
    homes: Vec<Regex>,
    user: Option<Regex>,
}

impl Identity {
    /// The running user's home folder and name.
    pub fn current() -> Self {
        let home = dirs::home_dir().map(|path| path.to_string_lossy().into_owned());
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .ok()
            .or_else(|| {
                dirs::home_dir()
                    .and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
            });
        Self::new(home.as_deref(), user.as_deref())
    }

    pub fn new(home: Option<&str>, user: Option<&str>) -> Self {
        let mut homes = Vec::new();
        if let Some(home) = home.map(|value| value.trim_end_matches(['/', '\\'])) {
            // A root home (`/`) would turn every path into `~`.
            if home.len() > 1 {
                homes.push(home.to_string());
                // Windows paths also reach the log with forward slashes, and
                // a JSON string escapes each backslash.
                homes.push(home.replace('\\', "/"));
                homes.push(home.replace('\\', "\\\\"));
                homes.dedup();
            }
        }
        // Longest first, so the escaped form is not half-replaced by the plain
        // one; and only up to a word boundary, so `/home/ann` leaves
        // `/home/anna` alone.
        homes.sort_by_key(|value| std::cmp::Reverse(value.len()));
        let homes = homes
            .iter()
            .filter_map(|home| {
                let ends_in_word = home.chars().last().is_some_and(|last| last.is_alphanumeric() || last == '_');
                let boundary = if ends_in_word { r"\b" } else { "" };
                Regex::new(&format!("{}{boundary}", regex::escape(home))).ok()
            })
            .collect();
        // Whole words only, and not a one-letter name, which would hit
        // ordinary words.
        let user = user
            .map(str::trim)
            .filter(|name| name.chars().count() >= 2)
            .and_then(|name| Regex::new(&format!(r"(?i)\b{}\b", regex::escape(name))).ok());
        Self { homes, user }
    }

    pub fn scrub<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut text = Cow::Borrowed(text);
        for home in &self.homes {
            if home.is_match(&text) {
                text = Cow::Owned(home.replace_all(&text, "~").into_owned());
            }
        }
        if let Some(user) = &self.user {
            if user.is_match(&text) {
                text = Cow::Owned(user.replace_all(&text, "<user>").into_owned());
            }
        }
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_keys_and_bearer_tokens_are_hidden() {
        let line = "POST failed: Authorization: Bearer abcdefghijklmnop sk-ant-api03-AAAAAAAAAAAAAAAAAAAA gsk_BBBBBBBBBBBBBBBBBBBB";
        let hidden = secrets(line);
        assert!(!hidden.contains("abcdefghijklmnop"));
        assert!(!hidden.contains("AAAAAAAAAAAAAAAA"));
        assert!(!hidden.contains("BBBBBBBBBBBBBBBB"));
        assert!(hidden.contains("sk-<redacted>"));
        assert!(hidden.contains("gsk_<redacted>"));
    }

    #[test]
    fn named_secrets_are_hidden_and_ordinary_words_stay() {
        assert_eq!(
            secrets(r#"url ?api_key=12345&model=x, "token": "abc", password=hunter2"#),
            r#"url ?api_key=<redacted>&model=x, "token": "<redacted>", password=<redacted>"#
        );
        let plain = "decoded 512 tokens in 3 s; max_tokens=200";
        assert_eq!(secrets(plain), plain);
        assert!(matches!(secrets(plain), Cow::Borrowed(_)));
    }

    #[test]
    fn home_becomes_tilde_and_the_user_name_is_replaced() {
        let identity = Identity::new(Some("/home/anna"), Some("anna"));
        assert_eq!(
            identity.scrub("model at /home/anna/.local/share/x, user anna, Annapolis, Anna, /home/annabel"),
            "model at ~/.local/share/x, user <user>, Annapolis, <user>, /home/annabel"
        );
    }

    #[test]
    fn windows_homes_in_each_spelling_are_replaced() {
        let identity = Identity::new(Some(r"C:\Users\Anna Lee"), Some("Anna Lee"));
        let text = r#"C:\Users\Anna Lee\AppData and C:/Users/Anna Lee/x and "C:\\Users\\Anna Lee\\y""#;
        assert_eq!(identity.scrub(text), r#"~\AppData and ~/x and "~\\y""#);
    }

    #[test]
    fn a_root_home_or_one_letter_name_is_left_alone() {
        let identity = Identity::new(Some("/"), Some("a"));
        assert_eq!(identity.scrub("/usr/bin a b"), "/usr/bin a b");
    }
}
