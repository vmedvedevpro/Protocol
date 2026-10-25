//! `updates/updater.log`: one line per updater event, because a Windows
//! release has no console and its stderr log goes nowhere. It holds UTC time,
//! the event, versions and error text, never user data, and is capped at
//! 256 KiB with one `.old` rotation. A bug report attaches this file.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

const LOG: &str = "updater.log";
const MAX_BYTES: u64 = 256 * 1024;

static WRITE: Mutex<()> = Mutex::new(());

pub fn record(dir: &Path, line: &str) {
    log::info!("[updater] {line}");
    let Ok(_guard) = WRITE.lock() else { return };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(LOG);
    if fs::metadata(&path).is_ok_and(|meta| meta.len() >= MAX_BYTES) {
        let _ = fs::rename(&path, dir.join(format!("{LOG}.old")));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {line}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_appended_and_the_file_rotates_at_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        record(dir.path(), "check started");
        record(dir.path(), "check found 0.3.1");
        let text = fs::read_to_string(dir.path().join(LOG)).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().nth(1).unwrap().ends_with(" check found 0.3.1"));

        fs::write(dir.path().join(LOG), vec![b'x'; MAX_BYTES as usize]).unwrap();
        record(dir.path(), "after rotation");
        assert!(dir.path().join("updater.log.old").exists());
        assert!(fs::read_to_string(dir.path().join(LOG)).unwrap().ends_with("after rotation\n"));
    }
}
