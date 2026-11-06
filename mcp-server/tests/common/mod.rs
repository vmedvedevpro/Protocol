//! A small library on disk, built by the app's own migrations and written the
//! way the app writes (sqlx defaults: rollback journal), for the server to read.

#![allow(dead_code)]

use protocol_mcp::store::{Library, Session, APP_MIGRATIONS};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::PathBuf;

pub const DB_FILE: &str = "meeting_minutes.sqlite";

/// Every kind of row the tools read, plus what they must never show: a
/// deleted meeting's leftovers (rows written with foreign keys off, as legacy
/// databases have), a person's phone and notes, a summary's hidden cache.
pub const LIBRARY: &str = r###"
INSERT INTO groups (id, name, normalized_name, color, kind, description, created_at, updated_at) VALUES
    ('g1', 'Budget committee', 'budget committee', '#ff0000', 'team', 'Monthly budget review', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
    ('g2', 'Клиент Альфа', 'клиент альфа', NULL, 'client', NULL, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO meetings (id, title, created_at, updated_at, group_id) VALUES
    ('m1', 'Budget review', '2026-10-01T09:00:00+00:00', '2026-10-01T10:00:00+00:00', 'g1'),
    ('m2', 'Планёрка по бюджету', '2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z', 'g2'),
    ('m3', 'Retro 50% done', '2026-10-03 10:00:00', '2026-10-03 11:00:00', 'g1'),
    ('m4', 'Empty call', '2026-10-04T09:00:00.000000+00:00', '2026-10-04T09:30:00Z', NULL);
INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time, duration) VALUES
    ('t1', 'm1', 'We need to cut the budget by ten percent', '2026-10-01T09:00:12.500Z', 'Speaker 2', 12.5, 15.0, NULL),
    ('t2', 'm1', 'Agreed.', '2026-10-01T09:00:16Z', 'You', 16.0, 17.0, NULL),
    ('t3', 'm1', 'And travel too.', '2026-10-01T09:00:18Z', 'You', 18.0, NULL, 2.0),
    ('t4', 'm1', 'Fine by me, the budget forecast can wait', '2026-10-01T09:00:21Z', 'Alice + Speaker 2', 21.0, 25.0, NULL),
    ('t5', 'm2', 'Бюджет утвердили, budget is final', '2026-10-02T09:00:03Z', 'Speaker 1', 3.0, 6.0, NULL),
    ('t6', 'm2', 'обсудили бюджет на квартал', '2026-10-02T09:00:07Z', 'Guest', 7.0, 9.0, NULL),
    ('t7', 'm3', 'Half of the work is 50% complete', '2026-10-03T10:00:01Z', 'Alice', 1.0, 4.0, NULL),
    ('t8', 'deleted-meeting', 'budget of a deleted meeting', '2026-09-30T09:00:00Z', 'Alice', 1.0, 2.0, NULL);
INSERT INTO people (id, display_name, normalized_name, notes, email, company, role, phone, created_at, updated_at) VALUES
    ('p1', 'Alice', 'alice', 'private note about Alice', 'alice@example.com', 'Acme', 'PM', '+1 555 0100', '2026-09-01 00:00:00', '2026-09-03 00:00:00'),
    ('p2', 'Bob', 'bob', 'Finance lead', NULL, NULL, NULL, NULL, '2026-09-01 00:00:00', '2026-09-02 00:00:00'),
    ('p3', 'Борис', 'борис', NULL, NULL, NULL, NULL, NULL, '2026-09-01 00:00:00', '2026-09-01 00:00:00');
INSERT INTO person_speakers (person_id, meeting_id, speaker_label) VALUES
    ('p1', 'm1', 'Speaker 2'), ('p1', 'm3', 'Alice'), ('p2', 'm3', 'Bob'), ('p1', 'deleted-meeting', 'Alice');
INSERT INTO meeting_notes (meeting_id, notes_markdown, created_at, updated_at) VALUES
    ('m1', 'Remember the travel freeze', '2026-10-01T09:30:00Z', '2026-10-01T09:30:00Z');
INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result, error, user_edited) VALUES
    ('m1', 'completed', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', '{"markdown":"## Decisions\n- Budget cut approved","english_cache":{"markdown":"cache text"}}', NULL, 1),
    ('m2', 'completed', '2026-10-02T10:00:00Z', '2026-10-02T10:00:00Z', '{"summary_json":[{"type":"heading","props":{"level":2},"content":[{"text":"Итоги"}]},{"type":"bulletListItem","content":[{"text":"Бюджет согласован"}]}]}', NULL, 0),
    ('m3', 'PENDING', '2026-10-03T11:00:00Z', '2026-10-03T12:00:00Z', '{"markdown":"Retro notes"}', NULL, 0),
    ('m4', 'failed', '2026-10-04T10:00:00Z', '2026-10-04T10:00:00Z', NULL, 'model not downloaded', 0),
    ('deleted-meeting', 'completed', '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z', '{"markdown":"ghost summary"}', NULL, 0);
INSERT INTO action_items (id, meeting_id, text, owner_label, person_id, due_text, done, source, position, created_at, updated_at) VALUES
    ('a1', 'm1', 'Send the budget to finance', 'Alice', 'p1', 'Friday', 0, 'ai', 0, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
    ('a2', 'm1', 'Book the room', 'You', NULL, NULL, 1, 'user', 1, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
    ('a3', 'm3', 'Close the budget ticket', 'Bob', 'p2', NULL, 0, 'user', 0, '2026-10-03T11:00:00Z', '2026-10-03T11:00:00Z'),
    ('a4', 'deleted-meeting', 'Ghost budget task', 'Alice', 'p1', NULL, 0, 'ai', 0, '2026-09-30T10:00:00Z', '2026-09-30T10:00:00Z');
"###;

pub struct Fixture {
    pub dir: tempfile::TempDir,
    pub db: PathBuf,
}

impl Fixture {
    /// The library above, with access for agents on.
    pub async fn new() -> Self {
        Self::with(LIBRARY).await
    }

    pub async fn with(rows: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join(DB_FILE);
        let pool = writer(&db, true).await;
        APP_MIGRATIONS.run(&pool).await.unwrap();
        // The deleted meeting's rows need foreign keys off.
        let mut conn = pool.acquire().await.unwrap();
        sqlx::query("PRAGMA foreign_keys = OFF").execute(&mut *conn).await.unwrap();
        sqlx::raw_sql(rows).execute(&mut *conn).await.unwrap();
        drop(conn);
        pool.close().await;
        meeting_library::agent_access::set_enabled(dir.path(), true).unwrap();
        Fixture { dir, db }
    }

    pub fn library(&self) -> Library {
        Library::new(&self.db)
    }

    pub async fn session(&self) -> Session {
        self.library().session().await.unwrap()
    }
}

/// A pool that writes like the app's: sqlx defaults, so a rollback journal and
/// a 5 s busy timeout.
pub async fn writer(db: &std::path::Path, create: bool) -> SqlitePool {
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(SqliteConnectOptions::new().filename(db).create_if_missing(create))
        .await
        .unwrap()
}
