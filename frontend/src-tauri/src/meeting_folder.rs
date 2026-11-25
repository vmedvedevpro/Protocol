//! Finds a meeting's folder after the recordings moved. A database carried to
//! another computer (or another OS) keeps each meeting's absolute
//! `folder_path`, such as `C:\Users\…\protocol-recordings\Standup_2025-10-02`
//! on Linux, while the folders themselves were copied into this computer's
//! recordings folder. A meeting folder's name (`<title>_<timestamp>`) is
//! what stays the same, so a missing folder is looked up by name there.

use std::path::{Path, PathBuf};

/// The last component of a stored folder path, whichever OS wrote it: a
/// Windows path is one opaque component on Linux, so both separators count.
fn folder_name(stored: &str) -> Option<&str> {
    stored
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .filter(|name| *name != "." && *name != "..")
}

/// `<recordings>/<name of stored>` when the stored folder is gone and that
/// one exists; `None` when the stored folder is there or nothing matches.
pub fn relocated(stored: &str, recordings: &Path) -> Option<PathBuf> {
    if Path::new(stored).is_dir() {
        return None;
    }
    let candidate = recordings.join(folder_name(stored)?);
    candidate.is_dir().then_some(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_folder_whichever_os_wrote_the_path() {
        assert_eq!(folder_name(r"C:\Users\User\Music\protocol-recordings\Standup_2025-10-02"), Some("Standup_2025-10-02"));
        assert_eq!(folder_name("/home/user/protocol-recordings/Standup_2025-10-02/"), Some("Standup_2025-10-02"));
        assert_eq!(folder_name(r"C:\"), Some("C:"));
        assert_eq!(folder_name(".."), None);
        assert_eq!(folder_name(""), None);
    }

    #[test]
    fn finds_a_moved_folder_by_name_in_the_recordings_folder() {
        let recordings = tempfile::tempdir().unwrap();
        std::fs::create_dir(recordings.path().join("Standup_2025-10-02")).unwrap();

        assert_eq!(
            relocated(r"C:\Users\User\Music\protocol-recordings\Standup_2025-10-02", recordings.path()),
            Some(recordings.path().join("Standup_2025-10-02"))
        );
        assert_eq!(relocated(r"C:\Users\User\Music\protocol-recordings\Gone_2025-10-03", recordings.path()), None);
    }

    #[test]
    fn leaves_a_folder_that_is_still_there() {
        let recordings = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let name = elsewhere.path().file_name().unwrap().to_str().unwrap();
        std::fs::create_dir(recordings.path().join(name)).unwrap();

        assert_eq!(relocated(elsewhere.path().to_str().unwrap(), recordings.path()), None);
    }
}
