//! Whether AI agents may read the library through `protocol-mcp`: Settings ›
//! AI agents writes `mcp-server.json` next to the database, and the server
//! reads it on every tool call, so turning access off takes effect at once,
//! even for a server a client already runs. A missing or unreadable file means
//! access is off.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

/// The switch file, in the folder that holds `meeting_minutes.sqlite`.
pub const FILE_NAME: &str = "mcp-server.json";

#[derive(Debug, Serialize, Deserialize)]
struct AccessFile {
    enabled: bool,
}

pub fn file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

pub fn is_enabled(data_dir: &Path) -> bool {
    std::fs::read(file_path(data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<AccessFile>(&bytes).ok())
        .is_some_and(|file| file.enabled)
}

/// Writes the switch through a temporary file and a rename, so a server that
/// reads it at the same moment sees the old or the new value, never half.
pub fn set_enabled(data_dir: &Path, enabled: bool) -> io::Result<()> {
    let target = file_path(data_dir);
    let temporary = data_dir.join(format!("{FILE_NAME}.tmp"));
    let bytes = serde_json::to_vec_pretty(&AccessFile { enabled }).map_err(io::Error::other)?;
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, &target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_is_off_until_turned_on() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_enabled(dir.path()));

        set_enabled(dir.path(), true).unwrap();
        assert!(is_enabled(dir.path()));
        set_enabled(dir.path(), false).unwrap();
        assert!(!is_enabled(dir.path()));
        assert!(!dir.path().join(format!("{FILE_NAME}.tmp")).exists());
    }

    #[test]
    fn an_unreadable_switch_means_off() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(file_path(dir.path()), b"{\"enabled\": tru").unwrap();
        assert!(!is_enabled(dir.path()));
        std::fs::write(file_path(dir.path()), b"{\"enabled\": \"yes\"}").unwrap();
        assert!(!is_enabled(dir.path()));
    }
}
