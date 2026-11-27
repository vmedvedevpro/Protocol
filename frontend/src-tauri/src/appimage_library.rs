//! A library an extract-and-run AppImage left in a temporary folder (#230).
//!
//! Before 1.0.0, an AppImage started with `APPIMAGE_EXTRACT_AND_RUN=1` (where
//! FUSE is missing) kept its data beside its executable, in
//! `/tmp/appimage_extracted_<hash>/usr/bin/data`. A reboot may clear that
//! folder and the next AppImage extracts under another hash, so an update
//! started empty. AppImages now use the XDG data folder (`paths.rs`); at start,
//! while that folder has no database, [`import_at_startup`] moves such a
//! library there once.
//!
//! The move copies into a staging folder inside the data root, checks every
//! copy, renames the copies into place and only then deletes the old folder.
//! Any failure deletes the staging folder, keeps the old one and tells the user
//! where it is: a start with an empty library and no word would look like the
//! meetings were lost.
//!
//! It runs at the start of Tauri's setup, after the single-instance plugin has
//! sent a second copy away, so no other Protocol has the old database open.

use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

const DATABASE: &str = "meeting_minutes.sqlite";
const EXTRACTED_PREFIX: &str = "appimage_extracted_";
/// Inside the data root, so the final renames stay on one file system.
const STAGING: &str = ".appimage-import";

/// What stays behind. Models and runtimes download again (the old run kept
/// about 1.4 GB of them in `/tmp`); caches rebuild; the old run's log and crash
/// records describe a run that has ended, and the new run already writes its
/// own. The database's journal files are read through the database itself.
const LEFT_BEHIND: [&str; 9] = [
    "models",
    "runtimes",
    "cache",
    "logs",
    "crash-reports",
    ".write_test",
    "meeting_minutes.sqlite-wal",
    "meeting_minutes.sqlite-shm",
    "meeting_minutes.sqlite-journal",
];

#[derive(Debug)]
pub enum Outcome {
    /// The data root has a database already, or no AppImage left one.
    Nothing,
    /// The library in `from` is now in the data root. `removed` says whether
    /// the old folder could be deleted after that.
    Moved {
        from: PathBuf,
        items: Vec<String>,
        removed: Result<(), String>,
    },
    /// More than one folder holds a library; which one is the user's is
    /// theirs to say, so none was moved.
    Several(Vec<PathBuf>),
    /// Nothing was moved and `from` is as it was.
    Failed { from: PathBuf, reason: String },
}

/// Moves a library left in `/tmp` into the data root once, logs what
/// happened, and tells the user when meetings stay behind.
pub fn import_at_startup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // A development build keeps its own library beside the executable.
    if crate::paths::data_root_is_portable() {
        return;
    }
    let root = crate::paths::install_data_root();
    // SAFETY: geteuid has no preconditions and cannot fail.
    let uid = unsafe { libc::geteuid() };
    let outcome = tauri::async_runtime::block_on(import_into(&root, &temp_dirs(), uid));
    match outcome {
        Outcome::Nothing => {}
        Outcome::Moved { from, items, removed } => {
            log::info!(
                "Moved the library an extract-and-run AppImage kept in {} to {}: {}. Models and runtimes download again.",
                from.display(),
                root.display(),
                items.join(", ")
            );
            // The library is safe in the data root; what is left is a copy
            // that the next reboot may clear anyway.
            if let Err(error) = removed {
                log::warn!("Could not delete {} after the move: {error}", from.display());
            }
        }
        Outcome::Several(folders) => {
            let list = folders.iter().map(|f| f.display().to_string()).collect::<Vec<_>>();
            log::warn!(
                "Several extract-and-run AppImage folders hold a Protocol library, so none was moved: {}",
                list.join(", ")
            );
            notify(
                app,
                format!(
                    "Earlier AppImage runs kept meetings in more than one temporary folder, so Protocol moved none of them:\n\n{}\n\nYour computer may delete these folders when it restarts. To keep those meetings, copy the folder you need somewhere safe.",
                    list.join("\n")
                ),
            );
        }
        Outcome::Failed { from, reason } => {
            log::error!(
                "Could not move the library in {} to {}: {reason}. It stays where it was.",
                from.display(),
                root.display()
            );
            notify(
                app,
                format!(
                    "Protocol could not move the meetings an earlier AppImage run kept in a temporary folder. They are still in:\n\n{}\n\nYour computer may delete that folder when it restarts, so copy it somewhere safe.\n\nReason: {reason}",
                    from.display()
                ),
            );
        }
    }
}

fn notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>, text: String) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    app.dialog()
        .message(text)
        .title("Meetings in a temporary folder")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// Where the AppImage runtime extracts: `$TMPDIR`, or `/tmp`.
fn temp_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    for dir in [PathBuf::from("/tmp"), std::env::temp_dir()] {
        let dir = fs::canonicalize(&dir).unwrap_or(dir);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// [`import_at_startup`] without the app: `root` is the data root, `temp_dirs`
/// the folders that hold `appimage_extracted_*`, `uid` this user's id.
pub async fn import_into(root: &Path, temp_dirs: &[PathBuf], uid: u32) -> Outcome {
    if fs::symlink_metadata(root.join(DATABASE)).is_ok() {
        return Outcome::Nothing;
    }
    let mut found = candidates(temp_dirs, uid);
    match found.len() {
        0 => Outcome::Nothing,
        1 => {
            let from = found.remove(0);
            match move_library(&from, root, uid).await {
                Ok(items) => {
                    let removed = fs::remove_dir_all(&from).map_err(|error| error.to_string());
                    Outcome::Moved { from, items, removed }
                }
                Err(reason) => Outcome::Failed { from, reason },
            }
        }
        _ => Outcome::Several(found),
    }
}

/// `<temp>/appimage_extracted_*/usr/bin/data` folders with a database, each
/// folder on the way a real folder of `uid`'s. `/tmp` is shared, so another
/// user's folder, or a link that leads elsewhere, is never this user's
/// library.
fn candidates(temp_dirs: &[PathBuf], uid: u32) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for temp in temp_dirs {
        let Ok(entries) = fs::read_dir(temp) else {
            continue;
        };
        for entry in entries.flatten() {
            if !entry.file_name().to_string_lossy().starts_with(EXTRACTED_PREFIX) {
                continue;
            }
            let extracted = entry.path();
            let data = extracted.join("usr").join("bin").join("data");
            let database = data.join(DATABASE);
            if fs::symlink_metadata(&database).is_err() {
                continue;
            }
            let chain = [
                extracted.clone(),
                extracted.join("usr"),
                extracted.join("usr").join("bin"),
                data.clone(),
                database,
            ];
            if chain.iter().all(|path| owned_real(path, uid)) {
                if !found.contains(&data) {
                    found.push(data);
                }
            } else {
                log::info!("Not importing {}: it is not this user's own folder", data.display());
            }
        }
    }
    found.sort();
    found
}

fn owned_real(path: &Path, uid: u32) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| !meta.file_type().is_symlink() && meta.uid() == uid)
        .unwrap_or(false)
}

/// Copies the library in `from` into `root` and returns the names it moved.
/// On an error `root` is as it was.
async fn move_library(from: &Path, root: &Path, uid: u32) -> Result<Vec<String>, String> {
    let mut items = Vec::new();
    for entry in fs::read_dir(from).map_err(|e| format!("cannot read {}: {e}", from.display()))? {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", from.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == DATABASE || LEFT_BEHIND.contains(&name.as_str()) {
            continue;
        }
        // The data root has no database yet, but a start that did not get
        // that far may have written a file of the same name; neither is
        // overwritten.
        if fs::symlink_metadata(root.join(&name)).is_ok() {
            return Err(format!("{} already exists", root.join(&name).display()));
        }
        items.push(name);
    }
    items.sort();

    let staging = root.join(STAGING);
    // Left by a start that ended in the middle of a move.
    if fs::symlink_metadata(&staging).is_ok() {
        fs::remove_dir_all(&staging).map_err(|e| format!("cannot clear {}: {e}", staging.display()))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("cannot create {}: {e}", staging.display()))?;

    let staged = stage(from, &staging, &items, uid).await;
    let result = staged.and_then(|()| {
        // The database goes in last: a database in the data root is what
        // stops the next start from trying again.
        let mut names = items.clone();
        names.push(DATABASE.to_string());
        rename_into(&staging, root, &names)
    });
    let _ = fs::remove_dir_all(&staging);
    result?;
    items.push(DATABASE.to_string());
    Ok(items)
}

async fn stage(from: &Path, staging: &Path, items: &[String], uid: u32) -> Result<(), String> {
    for name in items {
        copy_verified(&from.join(name), &staging.join(name), uid)
            .map_err(|e| format!("cannot copy {}: {e}", from.join(name).display()))?;
    }
    copy_database(&from.join(DATABASE), &staging.join(DATABASE)).await
}

/// Renames `names` from `staging` into `root`, or none of them.
fn rename_into(staging: &Path, root: &Path, names: &[String]) -> Result<(), String> {
    for (done, name) in names.iter().enumerate() {
        if let Err(error) = fs::rename(staging.join(name), root.join(name)) {
            for moved in &names[..done] {
                let _ = fs::rename(root.join(moved), staging.join(moved));
            }
            return Err(format!("cannot move {} into {}: {error}", name, root.display()));
        }
    }
    Ok(())
}

/// Copies a file or folder, checks each file against its source and writes it
/// to disk before the source can go. Links and files of other users fail it.
fn copy_verified(src: &Path, dst: &Path, uid: u32) -> io::Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.uid() != uid {
        return Err(io::Error::other(format!("{} belongs to another user", src.display())));
    }
    let kind = meta.file_type();
    if kind.is_dir() {
        fs::create_dir(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_verified(&entry.path(), &dst.join(entry.file_name()), uid)?;
        }
        Ok(())
    } else if kind.is_file() {
        fs::copy(src, dst)?;
        fs::File::open(dst)?.sync_all()?;
        if same_contents(src, dst)? {
            Ok(())
        } else {
            Err(io::Error::other(format!("the copy of {} differs from it", src.display())))
        }
    } else {
        Err(io::Error::other(format!("{} is not a plain file or folder", src.display())))
    }
}

fn same_contents(a: &Path, b: &Path) -> io::Result<bool> {
    let (mut a, mut b) = (fs::File::open(a)?, fs::File::open(b)?);
    if a.metadata()?.len() != b.metadata()?.len() {
        return Ok(false);
    }
    let (mut x, mut y) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = read_full(&mut a, &mut x)?;
        let m = read_full(&mut b, &mut y)?;
        if x[..n] != y[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

fn read_full(file: &mut fs::File, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match file.read(&mut buf[filled..])? {
            0 => break,
            read => filled += read,
        }
    }
    Ok(filled)
}

/// Writes a copy of the database with `VACUUM INTO`, which reads through any
/// write-ahead log a crash left beside it, so the copy is one consistent file.
/// The copy must pass `integrity_check` and hold the same tables with the same
/// row counts as the source.
async fn copy_database(src: &Path, dst: &Path) -> Result<(), String> {
    use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
    use sqlx::{ConnectOptions, Connection};

    async fn open(path: &Path) -> Result<SqliteConnection, String> {
        SqliteConnectOptions::new()
            .filename(path)
            .read_only(true)
            .connect()
            .await
            .map_err(|e| format!("cannot open {}: {e}", path.display()))
    }
    async fn row_counts(connection: &mut SqliteConnection) -> Result<Vec<(String, i64)>, String> {
        let tables: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .fetch_all(&mut *connection)
                .await
                .map_err(|e| e.to_string())?;
        let mut counts = Vec::new();
        for table in tables {
            let query = format!("SELECT count(*) FROM \"{}\"", table.replace('"', "\"\""));
            let count: i64 = sqlx::query_scalar(&query)
                .fetch_one(&mut *connection)
                .await
                .map_err(|e| e.to_string())?;
            counts.push((table, count));
        }
        Ok(counts)
    }

    let mut source = open(src).await?;
    sqlx::query("VACUUM INTO ?")
        .bind(dst.to_string_lossy().into_owned())
        .execute(&mut source)
        .await
        .map_err(|e| format!("cannot copy {}: {e}", src.display()))?;
    fs::File::open(dst)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("cannot write {}: {e}", dst.display()))?;

    let mut copy = open(dst).await?;
    let check: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(&mut copy)
        .await
        .map_err(|e| format!("cannot check the copied database: {e}"))?;
    if check != "ok" {
        return Err(format!("the copied database fails its integrity check: {check}"));
    }
    let expected = row_counts(&mut source).await?;
    let copied = row_counts(&mut copy).await?;
    let _ = source.close().await;
    let _ = copy.close().await;
    if expected != copied {
        return Err("the copied database does not hold the same rows as the original".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uid() -> u32 {
        unsafe { libc::geteuid() }
    }

    /// A temporary folder with an extract-and-run library in it, as rc.2 left
    /// one: a database with a WAL that was never checkpointed, a recording,
    /// voice profiles, models and runtimes.
    async fn left_library(temp: &Path, hash: &str) -> PathBuf {
        use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode};
        use sqlx::{ConnectOptions, Connection, Executor};

        let data = temp.join(format!("appimage_extracted_{hash}")).join("usr/bin/data");
        fs::create_dir_all(data.join("models/whisper")).unwrap();
        fs::create_dir_all(data.join("runtimes")).unwrap();
        fs::create_dir_all(data.join("voiceprint")).unwrap();
        fs::write(data.join("models/whisper/ggml.bin"), b"model").unwrap();
        fs::write(data.join("recording-2026-11-26T10-00-00.wav"), vec![7u8; 200_000]).unwrap();
        fs::write(data.join("voice_profiles.json"), b"{}").unwrap();
        fs::write(data.join("voiceprint/user_voiceprint.json"), b"[1,2]").unwrap();

        let mut connection = SqliteConnectOptions::new()
            .filename(data.join(DATABASE))
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .connect()
            .await
            .unwrap();
        connection.execute("PRAGMA wal_autocheckpoint = 0").await.unwrap();
        connection.execute("CREATE TABLE meetings (id TEXT, title TEXT)").await.unwrap();
        connection
            .execute("INSERT INTO meetings VALUES ('m1', 'Standup'), ('m2', 'Retro')")
            .await
            .unwrap();
        // Copy the files while the WAL still holds the rows, as after a crash.
        let crashed = temp.join(format!("crashed-{hash}"));
        fs::create_dir_all(&crashed).unwrap();
        for name in [DATABASE, "meeting_minutes.sqlite-wal"] {
            fs::copy(data.join(name), crashed.join(name)).unwrap();
        }
        // Closing checkpoints the WAL into the database and deletes it.
        connection.close().await.unwrap();
        for name in [DATABASE, "meeting_minutes.sqlite-wal"] {
            fs::copy(crashed.join(name), data.join(name)).unwrap();
        }
        let _ = fs::remove_file(data.join("meeting_minutes.sqlite-shm"));
        fs::remove_dir_all(&crashed).unwrap();
        data
    }

    async fn meetings_in(database: &Path) -> i64 {
        use sqlx::sqlite::SqliteConnectOptions;
        use sqlx::ConnectOptions;
        let mut connection = SqliteConnectOptions::new().filename(database).connect().await.unwrap();
        sqlx::query_scalar("SELECT count(*) FROM meetings")
            .fetch_one(&mut connection)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn moves_the_database_and_recordings_and_leaves_models_behind() {
        let temp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = left_library(temp.path(), "a1").await;

        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid()).await;

        match outcome {
            Outcome::Moved { from, items, removed } => {
                assert_eq!(from, data);
                // The database is renamed into place last.
                assert_eq!(
                    items,
                    ["recording-2026-11-26T10-00-00.wav", "voice_profiles.json", "voiceprint", DATABASE]
                );
                assert!(removed.is_ok());
            }
            other => panic!("expected a move, got {other:?}"),
        }
        // The rows the WAL held came along.
        assert_eq!(meetings_in(&root.path().join(DATABASE)).await, 2);
        assert_eq!(
            fs::read(root.path().join("recording-2026-11-26T10-00-00.wav")).unwrap(),
            vec![7u8; 200_000]
        );
        assert!(root.path().join("voiceprint/user_voiceprint.json").is_file());
        assert!(!root.path().join("models").exists());
        assert!(!root.path().join("runtimes").exists());
        assert!(!root.path().join(STAGING).exists());
        assert!(!data.exists());
    }

    #[tokio::test]
    async fn a_data_root_with_a_database_is_left_alone() {
        let temp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = left_library(temp.path(), "a1").await;
        fs::write(root.path().join(DATABASE), b"").unwrap();

        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid()).await;

        assert!(matches!(outcome, Outcome::Nothing), "{outcome:?}");
        assert!(data.join(DATABASE).exists());
    }

    #[tokio::test]
    async fn two_libraries_move_neither() {
        let temp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let first = left_library(temp.path(), "a1").await;
        let second = left_library(temp.path(), "b2").await;

        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid()).await;

        match outcome {
            Outcome::Several(folders) => assert_eq!(folders, vec![first.clone(), second.clone()]),
            other => panic!("expected several, got {other:?}"),
        }
        assert!(first.join(DATABASE).exists() && second.join(DATABASE).exists());
        assert!(!root.path().join(DATABASE).exists());
    }

    #[tokio::test]
    async fn another_users_folder_is_not_imported() {
        let temp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = left_library(temp.path(), "a1").await;

        // Seen as another user: every file here belongs to this test's user.
        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid() + 1).await;

        assert!(matches!(outcome, Outcome::Nothing), "{outcome:?}");
        assert!(data.join(DATABASE).exists());
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn a_link_into_the_temporary_folder_is_not_followed() {
        let temp = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        left_library(elsewhere.path(), "a1").await;
        std::os::unix::fs::symlink(
            elsewhere.path().join("appimage_extracted_a1"),
            temp.path().join("appimage_extracted_a1"),
        )
        .unwrap();

        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid()).await;

        assert!(matches!(outcome, Outcome::Nothing), "{outcome:?}");
    }

    #[tokio::test]
    async fn a_name_taken_in_the_data_root_keeps_the_old_folder() {
        let temp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = left_library(temp.path(), "a1").await;
        fs::write(root.path().join("voice_profiles.json"), b"{\"newer\":1}").unwrap();

        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid()).await;

        match outcome {
            Outcome::Failed { from, reason } => {
                assert_eq!(from, data);
                assert!(reason.contains("voice_profiles.json already exists"), "{reason}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
        assert!(data.join(DATABASE).exists());
        assert!(!root.path().join(DATABASE).exists());
        assert_eq!(fs::read(root.path().join("voice_profiles.json")).unwrap(), b"{\"newer\":1}");
    }

    #[tokio::test]
    async fn a_damaged_database_keeps_the_old_folder_and_writes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let data = left_library(temp.path(), "a1").await;
        fs::remove_file(data.join("meeting_minutes.sqlite-wal")).unwrap();
        fs::write(data.join(DATABASE), b"not a database at all").unwrap();

        let outcome = import_into(root.path(), &[temp.path().to_path_buf()], uid()).await;

        assert!(matches!(outcome, Outcome::Failed { .. }), "{outcome:?}");
        assert!(data.join(DATABASE).exists());
        assert!(data.join("recording-2026-11-26T10-00-00.wav").exists());
        assert!(fs::read_dir(root.path()).unwrap().next().is_none());
    }
}
