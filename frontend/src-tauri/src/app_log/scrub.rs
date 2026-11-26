//! What the log hides: secrets as each line is written, and the home folder
//! and user name in the copy Save logs makes. Meeting content is kept out at
//! the call sites instead (docs/APP_LOG.md).

use once_cell::sync::Lazy;
use regex::Regex;
use std::borrow::Cow;

static PROVIDER_KEY: Lazy<Regex> = Lazy::new(|| {
    // OpenAI and Anthropic (`sk-`, `sk-ant-`), OpenRouter (`sk-or-`), Groq
    // (`gsk_`) and the `sk_` keys of other services.
    Regex::new(r"\b(sk[-_]|gsk_)[A-Za-z0-9_\-]{16,}").unwrap()
});
static BEARER: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}").unwrap());
/// `api_key=…`, `"token": "…"`, and `api_key: Some("…")` as `{:?}` prints a
/// struct. The value needs a character other than a digit, so llama.cpp's
/// `BOS token = 1` stays.
static NAMED_SECRET: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"(?i)\b(api[_-]?key|x-api-key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)(\s*["']?\s*[:=]\s*(?:Some\()?["']?)[^\s"',;&})]*[^\s"',;&})0-9][^\s"',;&})]*"#,
    )
    .unwrap()
});
/// A bare `?key=` or `&key=` in a URL, as Gemini-style endpoints take it.
static QUERY_KEY: Lazy<Regex> = Lazy::new(|| Regex::new(r#"(?i)([?&]key=)[^&#\s"']+"#).unwrap());
/// The `user:password@` of a URL.
static USERINFO: Lazy<Regex> = Lazy::new(|| Regex::new(r"(://)[^/\s:@]+:[^/\s@]+@").unwrap());

/// `text` with every match of `re` replaced by `with`, borrowed when nothing
/// matched.
fn sub<'a>(re: &Regex, text: Cow<'a, str>, with: &str) -> Cow<'a, str> {
    let replaced = match re.replace_all(&text, with) {
        Cow::Borrowed(_) => None,
        Cow::Owned(replaced) => Some(replaced),
    };
    replaced.map_or(text, Cow::Owned)
}

/// `line` with API keys, bearer tokens, URL credentials and `key=value`
/// secrets replaced.
pub fn secrets(line: &str) -> Cow<'_, str> {
    let text = sub(&PROVIDER_KEY, Cow::Borrowed(line), "${1}<redacted>");
    let text = sub(&BEARER, text, "Bearer <redacted>");
    let text = sub(&NAMED_SECRET, text, "${1}${2}<redacted>");
    let text = sub(&QUERY_KEY, text, "${1}<redacted>");
    sub(&USERINFO, text, "${1}<redacted>@")
}

/// Logins that are ordinary words; replacing them would garble the text.
const COMMON_LOGINS: [&str; 5] = ["root", "user", "admin", "administrator", "guest"];

/// Rewrites the home folder as `~` and the user name as `<user>`, for files
/// a tester sends.
pub struct Identity {
    home: Option<Regex>,
    user: Option<Regex>,
}

impl Identity {
    /// The running user's home folder and name.
    pub fn current() -> Self {
        let home = dirs::home_dir().map(|path| path.to_string_lossy().into_owned());
        let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok().or_else(|| {
            let home = home.as_deref()?;
            home.rsplit(['/', '\\']).next().map(str::to_string)
        });
        Self::new(home.as_deref(), user.as_deref())
    }

    pub fn new(home: Option<&str>, user: Option<&str>) -> Self {
        let home = home
            .map(|value| value.trim_end_matches(['/', '\\']))
            // A root home (`/`) would turn every path into `~`.
            .filter(|value| value.len() > 1)
            .and_then(|value| Regex::new(&home_pattern(value)).ok());
        // Whole words only, and not a one-letter name, which would hit
        // ordinary words.
        let user = user
            .map(str::trim)
            .filter(|name| name.chars().count() >= 2)
            .filter(|name| !COMMON_LOGINS.iter().any(|common| name.eq_ignore_ascii_case(common)))
            .and_then(|name| Regex::new(&format!(r"(?i)\b{}\b", spaced(name))).ok());
        Self { home, user }
    }

    pub fn scrub<'a>(&self, text: &'a str) -> Cow<'a, str> {
        let mut text = Cow::Borrowed(text);
        if let Some(home) = &self.home {
            text = sub(home, text, "~");
        }
        if let Some(user) = &self.user {
            text = sub(user, text, "<user>");
        }
        text
    }
}

/// The home folder in every spelling a file can hold, as one pattern: any
/// case (Windows paths), each separator as `\`, `/` or JSON's `\\` (longest
/// first, so an escaped path is not half-replaced), the last folder also as
/// its 8.3 short name (`ANNALE~1`) on Windows, and a space also as `%20`. It
/// ends at a word boundary, so `/home/ann` leaves `/home/anna` alone.
fn home_pattern(home: &str) -> String {
    let (parent, name) = home.rsplit_once(['/', '\\']).unwrap_or(("", home));
    let separator = r"(?:\\\\|\\|/)";
    let parent: Vec<String> = parent.split(['/', '\\']).map(spaced).collect();
    let boundary = |text: &str| match text.chars().last() {
        Some(last) if last.is_alphanumeric() || last == '_' => r"\b",
        _ => "",
    };
    let mut names = vec![format!("{}{}", spaced(name), boundary(name))];
    if home.contains('\\') {
        names.push(format!(r"{}~[0-9]+\b", regex::escape(&short_stem(name))));
    }
    format!("(?i){}{separator}(?:{})", parent.join(separator), names.join("|"))
}

/// `name` escaped, a space also matching `%20` (a `file://` URL).
fn spaced(name: &str) -> String {
    regex::escape(name).replace(' ', "(?: |%20)")
}

/// The first six characters Windows keeps of a long name for its short one:
/// upper case, without spaces and dots.
fn short_stem(name: &str) -> String {
    name.chars().filter(|c| !matches!(c, ' ' | '.')).take(6).flat_map(char::to_uppercase).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_keys_and_bearer_tokens_are_hidden() {
        let line = "POST failed: Authorization: Bearer abcdefghijklmnop sk-ant-api03-AAAAAAAAAAAAAAAAAAAA gsk_BBBBBBBBBBBBBBBBBBBB sk_live_CCCCCCCCCCCCCCCCCCCC";
        let hidden = secrets(line);
        for secret in ["abcdefghijklmnop", "AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"] {
            assert!(!hidden.contains(secret), "{hidden}");
        }
        assert!(hidden.contains("sk-<redacted>") && hidden.contains("gsk_<redacted>") && hidden.contains("sk_<redacted>"));
    }

    #[test]
    fn named_secrets_are_hidden_and_ordinary_words_stay() {
        assert_eq!(
            secrets(r#"url ?api_key=12345a&model=x, "token": "abc", password=hunter2, api_key: Some("abc123")"#),
            r#"url ?api_key=<redacted>&model=x, "token": "<redacted>", password=<redacted>, api_key: Some("<redacted>")"#
        );
        let plain = "decoded 512 tokens in 3 s; max_tokens=200; BOS token = 1 '<s>'";
        assert_eq!(secrets(plain), plain);
        assert!(matches!(secrets(plain), Cow::Borrowed(_)));
    }

    #[test]
    fn url_keys_and_credentials_are_hidden() {
        assert_eq!(
            secrets("GET https://anna:hunter2@host/v1/models?key=AIzaXYZ&alt=json"),
            "GET https://<redacted>@host/v1/models?key=<redacted>&alt=json"
        );
        // A plain address, and a `key` that is not a query parameter.
        let plain = "https://host:8080/v1 cache key=abc";
        assert_eq!(secrets(plain), plain);
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
        let text = r#"C:\Users\Anna Lee\AppData, c:\users\anna lee\x, C:/Users/Anna Lee/x, "C:\\Users\\Anna Lee\\y", C:\Users\ANNALE~1\AppData, file:///C:/Users/Anna%20Lee/z, Anna%20Lee"#;
        assert_eq!(identity.scrub(text), r#"~\AppData, ~\x, ~/x, "~\\y", ~\AppData, file:///~/z, <user>"#);
    }

    #[test]
    fn a_root_home_a_common_login_or_one_letter_name_is_left_alone() {
        let text = "/usr/bin a b, the root user";
        assert_eq!(Identity::new(Some("/"), Some("a")).scrub(text), text);
        assert_eq!(Identity::new(Some("/root"), Some("root")).scrub("/root/x, the root user"), "~/x, the root user");
        assert_eq!(Identity::new(None, Some("User")).scrub(text), text);
    }
}
