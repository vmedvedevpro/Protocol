//! SQL functions the meeting library's queries need on every connection.
//!
//! SQLite's `lower()` and `LIKE` fold case for ASCII letters only, so
//! `lower('Бюджет') LIKE '%бюджет%'` is false and a capitalised Russian word
//! was found only as written. `unicode_lower(text)` lowercases every letter
//! that has a lowercase form, as Rust's `char::to_lowercase` does, so it meets
//! a query lowered by `normalize_person_name` (`str::to_lowercase`; the two
//! differ only on the Greek final sigma).
//!
//! The function lives in the connection, not in the database: nothing is
//! written, so the read-only MCP server registers it too, and no migration is
//! involved. Every pool whose connections run these queries must register it
//! (`SqlitePoolOptions::after_connect`), or they fail with "no such function".

use std::cell::RefCell;
use std::ffi::{c_char, c_int};

use libsqlite3_sys as ffi;
use sqlx::SqliteConnection;

/// Registers `unicode_lower` on `conn`.
pub async fn register(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut handle = conn.lock_handle().await?;
    // SAFETY: the handle is locked for the call; the name is a static C string
    // and the callback has no user data to outlive the connection.
    let code = unsafe {
        ffi::sqlite3_create_function_v2(
            handle.as_raw_handle().as_ptr(),
            c"unicode_lower".as_ptr(),
            1,
            ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC | ffi::SQLITE_INNOCUOUS,
            std::ptr::null_mut(),
            Some(unicode_lower),
            None,
            None,
            None,
        )
    };
    if code == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!(
            "could not register unicode_lower (SQLite code {code})"
        )))
    }
}

thread_local! {
    // The search calls the function once per transcript line, so the lowered
    // text is built in one buffer per thread instead of a new allocation per
    // row; SQLite copies it out (SQLITE_TRANSIENT), as it does for lower().
    static LOWERED: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// A buffer that grew past this for one huge row is not kept.
const KEPT_CAPACITY: usize = 64 * 1024;

/// NULL stays NULL, like `lower()`.
unsafe extern "C" fn unicode_lower(
    ctx: *mut ffi::sqlite3_context,
    _argc: c_int,
    argv: *mut *mut ffi::sqlite3_value,
) {
    let value = *argv;
    if ffi::sqlite3_value_type(value) == ffi::SQLITE_NULL {
        ffi::sqlite3_result_null(ctx);
        return;
    }
    // sqlite3_value_text first, then sqlite3_value_bytes: the documented order
    // for a length that matches the returned text.
    let text = ffi::sqlite3_value_text(value);
    if text.is_null() {
        ffi::sqlite3_result_error_nomem(ctx);
        return;
    }
    let bytes = std::slice::from_raw_parts(text, ffi::sqlite3_value_bytes(value) as usize);
    LOWERED.with_borrow_mut(|lowered| {
        lowered.clear();
        push_lowercase(bytes, lowered);
        match c_int::try_from(lowered.len()) {
            Ok(length) => ffi::sqlite3_result_text(
                ctx,
                lowered.as_ptr() as *const c_char,
                length,
                ffi::SQLITE_TRANSIENT(),
            ),
            Err(_) => ffi::sqlite3_result_error_toobig(ctx),
        }
        if lowered.capacity() > KEPT_CAPACITY {
            *lowered = Vec::new();
        }
    });
}

/// Appends `text` lowercased. Runs that need no change (ASCII without
/// capitals, lowercase modern Cyrillic: most of a Protocol library) are copied
/// whole, and ASCII and Cyrillic capitals are rewritten byte by byte. Any other
/// character goes through `char::to_lowercase`, whose table lookup per
/// character made the search about twice as slow when it handled every letter.
/// Bytes that are not valid UTF-8 are copied unchanged.
fn push_lowercase(text: &[u8], out: &mut Vec<u8>) {
    out.reserve(text.len());
    let mut at = 0;
    while at < text.len() {
        let unchanged = at;
        while let Some(&byte) = text.get(at) {
            let width = match (byte, text.get(at + 1)) {
                (b'A'..=b'Z', _) => 0,
                (0x00..=0x7F, _) => 1,
                (0xD0, Some(0xB0..=0xBF)) | (0xD1, Some(0x80..=0x9F)) => 2,
                _ => 0,
            };
            if width == 0 {
                break;
            }
            at += width;
        }
        out.extend_from_slice(&text[unchanged..at]);
        let Some(&lead) = text.get(at) else { break };
        if lead < 0x80 {
            out.push(lead.to_ascii_lowercase());
            at += 1;
            continue;
        }
        if let (0xD0 | 0xD1, Some(&next)) = (lead, text.get(at + 1)) {
            // UTF-8 of U+0400–U+047F is D0 80..D1 BF.
            let pair = match (lead, next) {
                // Ѐ–Џ (U+0400–040F) → ѐ–џ (U+0450–045F)
                (0xD0, 0x80..=0x8F) => Some([0xD1, next + 0x10]),
                // А–П (U+0410–041F) → а–п (U+0430–043F)
                (0xD0, 0x90..=0x9F) => Some([0xD0, next + 0x20]),
                // Р–Я (U+0420–042F) → р–я (U+0440–044F)
                (0xD0, 0xA0..=0xAF) => Some([0xD1, next - 0x20]),
                _ => None,
            };
            if let Some(pair) = pair {
                out.extend_from_slice(&pair);
                at += 2;
                continue;
            }
        }
        let width = match lead {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        let character = text
            .get(at..at + width)
            .and_then(|slice| std::str::from_utf8(slice).ok())
            .and_then(|slice| slice.chars().next());
        match character {
            Some(character) => {
                let mut encoded = [0; 4];
                for lower in character.to_lowercase() {
                    out.extend_from_slice(lower.encode_utf8(&mut encoded).as_bytes());
                }
                at += width;
            }
            None => {
                out.push(lead);
                at += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use sqlx::{Connection, SqliteConnection};

    fn lowered(text: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        super::push_lowercase(text, &mut out);
        out
    }

    /// The byte-level Cyrillic path agrees with char::to_lowercase on every
    /// character it handles, and the rest of the alphabet is lowered too.
    #[test]
    fn agrees_with_char_to_lowercase() {
        // Latin, Greek, Cyrillic and Armenian, and their extended blocks.
        for code in (0..0x0590u32).chain(0x1E00..0x2000).chain(0x2C00..0x2D00) {
            let Some(character) = char::from_u32(code) else { continue };
            let expected: String = character.to_lowercase().collect();
            let text = character.to_string();
            assert_eq!(lowered(text.as_bytes()), expected.as_bytes(), "U+{code:04X}");
        }
        assert_eq!(lowered("Съешь ЖЕ ЕЩЁ этих Ёлок, İstanbul".as_bytes()), "съешь же ещё этих ёлок, i̇stanbul".as_bytes());
        // Invalid UTF-8 and a sequence cut short come back as they were.
        assert_eq!(lowered(b"A\xFF\xD0"), b"a\xFF\xD0");
    }

    #[tokio::test]
    async fn lowers_every_alphabet_and_keeps_null() {
        let mut conn = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        super::register(&mut conn).await.unwrap();
        let (cyrillic, mixed, number, null, like): (String, String, String, Option<String>, bool) =
            sqlx::query_as(
                "SELECT unicode_lower('БЮДЖЕТ Ёлки'), unicode_lower('Q3 Бюджет ÄÖÜ'), \
                 unicode_lower(42), unicode_lower(NULL), \
                 unicode_lower('Обсудили Бюджет') LIKE '%бюджет%'",
            )
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert_eq!(cyrillic, "бюджет ёлки");
        assert_eq!(mixed, "q3 бюджет äöü");
        assert_eq!(number, "42");
        assert_eq!(null, None);
        assert!(like);
        // The built-in one, for contrast: the reason this function exists.
        let builtin: bool = sqlx::query_scalar("SELECT lower('Обсудили Бюджет') LIKE '%бюджет%'")
            .fetch_one(&mut conn)
            .await
            .unwrap();
        assert!(!builtin);
    }
}
