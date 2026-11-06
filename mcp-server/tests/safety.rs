//! The server never changes the library and never holds up the app.

mod common;

use common::{writer, Fixture, DB_FILE};
use protocol_mcp::store::{Library, Problem, STATEMENT_TIME};
use protocol_mcp::tools::{self, *};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

fn files(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn stamp(path: &Path) -> (Vec<u8>, SystemTime) {
    (std::fs::read(path).unwrap(), std::fs::metadata(path).unwrap().modified().unwrap())
}

/// Every tool, then writes through the server's own connection: the file's
/// bytes and mtime stay the same and no journal appears next to it.
#[tokio::test]
async fn reading_changes_nothing_on_disk() {
    let fixture = Fixture::new().await;
    let before_files = files(fixture.dir.path());
    let before = stamp(&fixture.db);
    let library = fixture.library();

    let mut session = library.session().await.unwrap();
    let conn = &mut session.conn;
    tools::list_meetings(conn, ListMeetingsArgs::default()).await.unwrap();
    tools::get_meeting(conn, GetMeetingArgs { meeting_id: "m1".into(), include_transcript: Some(true) }).await.unwrap();
    tools::get_transcript(conn, GetTranscriptArgs { meeting_id: "m2".into(), offset: None, limit: None }).await.unwrap();
    tools::get_summary(conn, GetSummaryArgs { meeting_id: "m2".into() }).await.unwrap();
    tools::get_action_items(conn, GetActionItemsArgs::default()).await.unwrap();
    tools::search(conn, SearchArgs { query: "budget".into(), ..Default::default() }).await.unwrap();
    tools::list_people(conn, ListPeopleArgs::default()).await.unwrap();
    tools::list_groups(conn, ListGroupsArgs::default()).await.unwrap();

    for write in [
        "INSERT INTO groups (id, name, normalized_name, created_at, updated_at) VALUES ('x', 'x', 'x', '', '')",
        "UPDATE meetings SET title = 'changed'",
        "DELETE FROM transcripts",
        "CREATE TABLE intruder (id INTEGER)",
        "PRAGMA query_only = OFF",
    ] {
        // `query_only` can be switched off, but the file stays read-only.
        let _ = sqlx::query(write).execute(&mut **conn).await;
    }
    let error = sqlx::query("UPDATE meetings SET title = 'changed'").execute(&mut **conn).await.unwrap_err();
    let code = error.as_database_error().and_then(|error| error.code()).unwrap().into_owned();
    assert_eq!(code.parse::<i32>().unwrap() & 0xff, 8, "SQLITE_READONLY expected, got {error}");

    drop(session);
    library.close().await;
    assert_eq!(files(fixture.dir.path()), before_files);
    assert!(stamp(&fixture.db) == before, "the database file changed");
}

/// A statement still running when the call's second is up is stopped and
/// answered with "narrow it"; the connection is fine for the next call.
#[tokio::test]
async fn a_call_stops_after_its_time() {
    let fixture = Fixture::new().await;
    let library = fixture.library();
    let mut session = library.session().await.unwrap();
    let started = Instant::now();
    let error = sqlx::query_scalar::<_, i64>(HEAVY).fetch_one(&mut *session.conn).await.unwrap_err();
    let elapsed = started.elapsed();
    assert_eq!(Problem::from(error), Problem::TooBroad);
    assert!(elapsed < STATEMENT_TIME + Duration::from_millis(500), "stopped after {elapsed:?}");
    drop(session);

    let mut next = library.session().await.unwrap();
    let text = tools::list_groups(&mut next.conn, ListGroupsArgs::default()).await.unwrap();
    assert!(text.contains("Budget committee"));
}

/// Reads the fixture's eight transcript rows 8^10 times over: minutes of
/// work, holding the database's SHARED lock the whole time it runs.
const HEAVY: &str = "SELECT COUNT(*) FROM transcripts a, transcripts b, transcripts c, transcripts d, \
                     transcripts e, transcripts f, transcripts g, transcripts h, transcripts i, transcripts j";

/// The app saves a transcript (its writes wait at most 5 s for a lock) while
/// the server runs a statement that would take minutes: the save commits once
/// the server's statement is stopped, about a second in.
#[tokio::test]
async fn the_app_saves_while_the_server_reads() {
    let fixture = Fixture::new().await;
    let library = fixture.library();
    let mut session = library.session().await.unwrap();
    let reader = tokio::spawn(async move { sqlx::query_scalar::<_, i64>(HEAVY).fetch_one(&mut *session.conn).await });
    // Let the statement take its lock first.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let app = writer(&fixture.db, false).await;
    let started = Instant::now();
    let mut tx = app.begin().await.unwrap();
    sqlx::query(
        "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time) \
         VALUES ('saved', 'm1', 'A line saved on Stop', '2026-10-01T09:30:00Z', 'You', 30.0, 31.0)",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.expect("the app's save must commit");
    let waited = started.elapsed();

    let result = reader.await.unwrap();
    assert_eq!(Problem::from(result.unwrap_err()), Problem::TooBroad);
    // It did wait for the server's lock, so the test exercised the conflict,
    // and no longer than the server's cap, well inside the app's 5 s.
    assert!(waited > Duration::from_millis(300), "the save did not wait ({waited:?}): no lock was held");
    assert!(waited < Duration::from_secs(2), "the save waited {waited:?}");
    app.close().await;

    let mut next = library.session().await.unwrap();
    let text = tools::get_transcript(&mut next.conn, GetTranscriptArgs { meeting_id: "m1".into(), offset: None, limit: None })
        .await
        .unwrap();
    assert!(text.contains("A line saved on Stop"), "the next call sees the save:\n{text}");
}

/// A journal left by a write that never finished (the app was killed) may be
/// rolled back only by a writer: the server asks for Protocol to be opened and
/// leaves the journal where it is.
#[tokio::test]
async fn an_unfinished_write_asks_for_protocol() {
    let fixture = Fixture::new().await;
    let crashed = tempfile::tempdir().unwrap();
    let journal = format!("{DB_FILE}-journal");

    let app = writer(&fixture.db, false).await;
    let mut tx = app.begin().await.unwrap();
    // A journal becomes hot once the write has started changing the database
    // file; before that its header is still zero. A tiny page cache makes the
    // transaction spill pages into the file halfway through.
    sqlx::query("PRAGMA cache_size = 5").execute(&mut *tx).await.unwrap();
    for index in 0..400 {
        sqlx::query("INSERT INTO transcripts (id, meeting_id, transcript, timestamp) VALUES (?, 'm1', ?, '2026-10-01T09:30:00Z')")
            .bind(format!("spill-{index}"))
            .bind("x".repeat(1_000))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    // A copy taken mid-write is what a killed app leaves behind.
    std::fs::copy(&fixture.db, crashed.path().join(DB_FILE)).unwrap();
    std::fs::copy(fixture.dir.path().join(&journal), crashed.path().join(&journal)).unwrap();
    tx.rollback().await.unwrap();
    app.close().await;
    let header = std::fs::read(crashed.path().join(&journal)).unwrap();
    assert_eq!(header[..8], [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7], "the copied journal is not hot");

    let library = Library::new(&crashed.path().join(DB_FILE));
    let problem = library.session().await.err().expect("a hot journal must not be read past");
    assert_eq!(problem, Problem::NeedsRecovery);
    assert!(problem.message().contains("Open Protocol once"));
    assert!(crashed.path().join(&journal).exists(), "the journal must stay for Protocol to roll back");
}

#[tokio::test]
async fn databases_protocol_has_not_migrated_or_did_not_create() {
    let fixture = Fixture::new().await;
    let app = writer(&fixture.db, false).await;
    let newest: i64 = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations").fetch_one(&app).await.unwrap();

    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = ?").bind(newest).execute(&app).await.unwrap();
    let older = fixture.library().session().await.err().unwrap();
    assert_eq!(older, Problem::OlderDatabase);
    assert!(older.message().contains("Open Protocol once"));

    sqlx::query(
        "INSERT INTO _sqlx_migrations (version, description, installed_on, success, checksum, execution_time) \
         VALUES (?, 'restored', CURRENT_TIMESTAMP, 1, x'00', 0), (99991231000000, 'from a newer Protocol', CURRENT_TIMESTAMP, 1, x'00', 0)",
    )
    .bind(newest)
    .execute(&app)
    .await
    .unwrap();
    let newer = fixture.library().session().await.unwrap();
    assert!(newer.newer_database);
    app.close().await;

    let stranger = tempfile::tempdir().unwrap();
    let path = stranger.path().join("other.sqlite");
    let other = writer(&path, true).await;
    sqlx::query("CREATE TABLE notes (id INTEGER)").execute(&other).await.unwrap();
    other.close().await;
    assert_eq!(Library::new(&path).session().await.err().unwrap(), Problem::NotProtocol(path));
}
