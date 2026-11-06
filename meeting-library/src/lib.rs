//! Read model of Protocol's meeting library, shared by the app and the
//! read-only `protocol-mcp` server (#8): the Ctrl+K search and the text of a
//! saved summary.
//!
//! Everything here reads the database the app's migrations create
//! (`frontend/src-tauri/migrations`); nothing writes to it.

pub mod search;
pub mod summary;

/// The form a person's or group's name takes in `people.normalized_name` and
/// `groups.normalized_name`, and the form search compares queries in.
pub fn normalize_person_name(name: &str) -> String {
    name.trim().to_lowercase()
}
