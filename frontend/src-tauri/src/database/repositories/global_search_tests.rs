//! Pins what the Ctrl+K search (`PeopleRepository::global_search`) returns on a
//! library built by the app's own migrations, so moving the search into the
//! shared `meeting-library` crate (#8) cannot change its results.

use super::person::PeopleRepository;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

/// Every result kind, mixed timestamp formats, Cyrillic text (SQLite's LIKE
/// folds ASCII only), LIKE wildcards in the query, a summary whose cache holds
/// the query but whose visible text does not, and a transcript row whose
/// meeting was deleted without foreign keys.
const LIBRARY: &str = r###"
INSERT INTO groups (id, name, normalized_name, color, created_at, updated_at) VALUES
    ('g1', 'Budget committee', 'budget committee', '#ff0000', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
INSERT INTO meetings (id, title, created_at, updated_at, group_id) VALUES
    ('m1', 'Budget review', '2026-10-01T09:00:00+00:00', '2026-10-01T10:00:00+00:00', 'g1'),
    ('m2', 'Планёрка по бюджету', '2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z', NULL),
    ('m3', 'Retro 50% done', '2026-10-03 10:00:00', '2026-10-03 11:00:00', 'g1');
INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time) VALUES
    ('t1', 'm1', 'We need to cut the budget by ten percent', '2026-10-01T09:00:12.500Z', 'Alice', 12.5, 15.0),
    ('t2', 'm1', 'Agreed.', '2026-10-01T09:00:16Z', 'You', 16.0, 17.0),
    ('t3', 'm2', 'Бюджет утвердили, budget is final', '2026-10-02T09:00:03Z', 'Speaker 2', 3.0, 6.0),
    ('t4', 'm3', 'Half of the work is 50% complete', '2026-10-03T10:00:01Z', 'Alice + Bob', 1.0, 4.0),
    ('t5', 'deleted-meeting', 'budget of a deleted meeting', '2026-09-30T09:00:00Z', 'Alice', 1.0, 2.0),
    ('t6', 'm1', 'This opening stretch talks about many unrelated things for quite a while so that the snippet has to start later than the beginning of the row, and then it finally mentions the budget forecast, followed by a long tail of other remarks that also keep going well past the snippet length.', '2026-10-01T09:01:00Z', 'Alice', 60.0, 75.0);
INSERT INTO people (id, display_name, normalized_name, notes, created_at, updated_at) VALUES
    ('p1', 'Alice', 'alice', NULL, '2026-09-01 00:00:00', '2026-09-03 00:00:00'),
    ('p2', 'Bob', 'bob', 'Finance lead', '2026-09-01 00:00:00', '2026-09-02 00:00:00'),
    ('p3', 'Budgetary Office', 'budgetary office', NULL, '2026-09-01 00:00:00', '2026-09-01 00:00:00');
INSERT INTO person_speakers (person_id, meeting_id, speaker_label) VALUES
    ('p1', 'm1', 'Alice'), ('p1', 'm3', 'Alice'), ('p2', 'm3', 'Bob');
INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) VALUES
    ('m1', 'completed', '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z', '{"markdown":"## Decisions\n- Budget cut approved"}'),
    ('m2', 'completed', '2026-10-02T10:00:00Z', '2026-10-02T10:00:00Z', '{"summary_json":[{"type":"paragraph","content":[{"text":"Бюджет согласован"}]}]}'),
    ('m3', 'completed', '2026-10-03T11:00:00Z', '2026-10-03T11:00:00Z', '{"markdown":"Retro notes","english_cache":{"markdown":"budget hidden in a cache"}}');
INSERT INTO action_items (id, meeting_id, text, owner_label, person_id, done, source, position, created_at, updated_at) VALUES
    ('a1', 'm1', 'Send the budget to finance', 'Alice', 'p1', 0, 'ai', 0, '2026-10-01T10:00:00Z', '2026-10-01T10:00:00Z'),
    ('a2', 'm3', 'Close the budget ticket', 'Bob', 'p2', 1, 'user', 0, '2026-10-03T11:00:00Z', '2026-10-03T11:00:00Z');
"###;

async fn library() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::migrate!("./migrations").run(&pool).await.unwrap();
    // The deleted meeting's transcript row needs foreign keys off, as in
    // legacy databases opened before they were enforced.
    sqlx::query("PRAGMA foreign_keys = OFF").execute(&pool).await.unwrap();
    sqlx::raw_sql(LIBRARY).execute(&pool).await.unwrap();
    pool
}

async fn search(pool: &SqlitePool, query: &str, limit: Option<i64>) -> serde_json::Value {
    serde_json::to_value(PeopleRepository::global_search(pool, query, limit).await.unwrap()).unwrap()
}

#[tokio::test]
async fn ctrl_k_results_stay_as_they_were() {
    let pool = library().await;

    let actual = serde_json::json!({
        "budget": search(&pool, "budget", None).await,
        "budget, limit 3": search(&pool, "  BUDGET ", Some(3)).await,
        "бюджет": search(&pool, "бюджет", None).await,
        "alice": search(&pool, "alice", None).await,
        "50%": search(&pool, "50%", None).await,
        "blank": search(&pool, "   ", None).await,
    });
    let expected: serde_json::Value = serde_json::from_str(EXPECTED).unwrap();
    assert_eq!(actual, expected, "{}", serde_json::to_string_pretty(&actual).unwrap());
}

/// What the search returned on this library before it moved (#8). Note the
/// quirks it keeps: "бюджет" misses the transcript line "Бюджет …" because
/// SQLite's LIKE folds ASCII only, while the summary match (Rust lowercase)
/// finds "Бюджет согласован"; the deleted meeting's line and the summary
/// cache never match.
const EXPECTED: &str = r###"{
  "50%": [
    {"id": "m3", "kind": "meeting", "meetingId": "m3", "snippet": "Retro 50% done",
     "timestamp": "2026-10-03 10:00:00", "title": "Retro 50% done"},
    {"audioStartTime": 1.0, "id": "t4", "kind": "transcript", "meetingId": "m3",
     "snippet": "Half of the work is 50% complete", "speaker": "Alice + Bob",
     "timestamp": "2026-10-03T10:00:01Z", "title": "Retro 50% done", "transcriptId": "t4"}
  ],
  "alice": [
    {"id": "p1", "kind": "person", "meetingCount": 2, "personId": "p1",
     "snippet": "2 mapped meetings", "title": "Alice"},
    {"audioStartTime": 1.0, "id": "t4", "kind": "transcript", "meetingId": "m3",
     "snippet": "Half of the work is 50% complete", "speaker": "Alice + Bob",
     "timestamp": "2026-10-03T10:00:01Z", "title": "Retro 50% done", "transcriptId": "t4"},
    {"audioStartTime": 60.0, "id": "t6", "kind": "transcript", "meetingId": "m1",
     "snippet": "This opening stretch talks about many unrelated things for quite a while so that the snippet has to start later than the beginning of the row, and then it finally mentions the budg...",
     "speaker": "Alice", "timestamp": "2026-10-01T09:01:00Z", "title": "Budget review", "transcriptId": "t6"},
    {"audioStartTime": 12.5, "id": "t1", "kind": "transcript", "meetingId": "m1",
     "snippet": "We need to cut the budget by ten percent", "speaker": "Alice",
     "timestamp": "2026-10-01T09:00:12.500Z", "title": "Budget review", "transcriptId": "t1"},
    {"id": "a1", "kind": "action", "meetingId": "m1", "snippet": "Send the budget to finance",
     "speaker": "Alice", "timestamp": "2026-10-01T09:00:00+00:00", "title": "Budget review"}
  ],
  "blank": [],
  "budget": [
    {"id": "m1", "kind": "meeting", "meetingId": "m1", "snippet": "Budget review",
     "timestamp": "2026-10-01T09:00:00+00:00", "title": "Budget review"},
    {"id": "p3", "kind": "person", "meetingCount": 0, "personId": "p3",
     "snippet": "0 mapped meetings", "title": "Budgetary Office"},
    {"color": "#ff0000", "groupId": "g1", "id": "g1", "kind": "group", "meetingCount": 2,
     "snippet": "2 meetings", "title": "Budget committee"},
    {"id": "a2", "kind": "action", "meetingId": "m3", "snippet": "Close the budget ticket",
     "speaker": "Bob", "timestamp": "2026-10-03 10:00:00", "title": "Retro 50% done"},
    {"id": "a1", "kind": "action", "meetingId": "m1", "snippet": "Send the budget to finance",
     "speaker": "Alice", "timestamp": "2026-10-01T09:00:00+00:00", "title": "Budget review"},
    {"audioStartTime": 3.0, "id": "t3", "kind": "transcript", "meetingId": "m2",
     "snippet": "Бюджет утвердили, budget is final", "speaker": "Speaker 2",
     "timestamp": "2026-10-02T09:00:03Z", "title": "Планёрка по бюджету", "transcriptId": "t3"},
    {"audioStartTime": 60.0, "id": "t6", "kind": "transcript", "meetingId": "m1",
     "snippet": "... the beginning of the row, and then it finally mentions the budget forecast, followed by a long tail of other remarks that also keep going well past the snippet length.",
     "speaker": "Alice", "timestamp": "2026-10-01T09:01:00Z", "title": "Budget review", "transcriptId": "t6"},
    {"audioStartTime": 12.5, "id": "t1", "kind": "transcript", "meetingId": "m1",
     "snippet": "We need to cut the budget by ten percent", "speaker": "Alice",
     "timestamp": "2026-10-01T09:00:12.500Z", "title": "Budget review", "transcriptId": "t1"},
    {"id": "summary-m1", "kind": "summary", "meetingId": "m1",
     "snippet": "## Decisions\n- Budget cut approved",
     "timestamp": "2026-10-01T09:00:00+00:00", "title": "Budget review"}
  ],
  "budget, limit 3": [
    {"id": "m1", "kind": "meeting", "meetingId": "m1", "snippet": "Budget review",
     "timestamp": "2026-10-01T09:00:00+00:00", "title": "Budget review"},
    {"id": "p3", "kind": "person", "meetingCount": 0, "personId": "p3",
     "snippet": "0 mapped meetings", "title": "Budgetary Office"},
    {"color": "#ff0000", "groupId": "g1", "id": "g1", "kind": "group", "meetingCount": 2,
     "snippet": "2 meetings", "title": "Budget committee"}
  ],
  "бюджет": [
    {"id": "m2", "kind": "meeting", "meetingId": "m2", "snippet": "Планёрка по бюджету",
     "timestamp": "2026-10-02T09:00:00Z", "title": "Планёрка по бюджету"},
    {"id": "summary-m2", "kind": "summary", "meetingId": "m2", "snippet": "Бюджет согласован",
     "timestamp": "2026-10-02T09:00:00Z", "title": "Планёрка по бюджету"}
  ]
}"###;
