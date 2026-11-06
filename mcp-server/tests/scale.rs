//! How long the heaviest calls take on a large library, and whether the app
//! can still save while they run. Builds a synthetic library of 300 one-hour
//! meetings (150,000 transcript lines, mostly Russian); minutes to build, so
//! it runs only when asked:
//!
//! `cargo test -p protocol-mcp --release --test scale -- --ignored --nocapture`

mod common;

use common::{writer, Fixture};
use protocol_mcp::store::{Library, Problem};
use protocol_mcp::text::estimated_tokens;
use protocol_mcp::tools::{self, *};
use std::future::Future;
use std::time::{Duration, Instant};

const MEETINGS: usize = 300;
const LINES_PER_MEETING: usize = 500;
const PEOPLE: usize = 40;
const GROUPS: usize = 12;

const WORDS: &[&str] = &[
    "бюджет", "квартал", "релиз", "клиент", "договор", "сроки", "команда", "задача", "отчёт", "встреча",
    "предлагаю", "согласовать", "перенести", "проверить", "обсудить", "давайте", "нужно", "потом", "сегодня",
    "завтра", "на", "по", "в", "и", "что", "это", "мы", "они", "у", "нас", "есть", "будет", "надо", "ещё",
    "deadline", "release", "budget", "API", "backend", "review", "sprint", "demo", "ok", "PR", "Jira",
];

/// A deterministic word stream: the same library on every run.
struct Words(u64);

impl Words {
    fn next(&mut self) -> &'static str {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        WORDS[(self.0 >> 33) as usize % WORDS.len()]
    }

    fn sentence(&mut self, words: usize) -> String {
        (0..words).map(|_| self.next()).collect::<Vec<_>>().join(" ")
    }
}

async fn build() -> Fixture {
    let fixture = Fixture::with("SELECT 1;").await;
    let pool = writer(&fixture.db, false).await;
    let mut words = Words(8);
    let mut tx = pool.begin().await.unwrap();
    for group in 0..GROUPS {
        sqlx::query("INSERT INTO groups (id, name, normalized_name, kind, created_at, updated_at) VALUES (?, ?, ?, 'team', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(format!("g{group}"))
            .bind(format!("Команда {group}"))
            .bind(format!("команда {group}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for person in 0..PEOPLE {
        sqlx::query("INSERT INTO people (id, display_name, normalized_name, created_at, updated_at) VALUES (?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .bind(format!("p{person}"))
            .bind(format!("Сотрудник {person}"))
            .bind(format!("сотрудник {person}"))
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    for meeting in 0..MEETINGS {
        let id = format!("m{meeting:03}");
        let day = chrono::NaiveDate::from_ymd_opt(2026, 1, 1).unwrap() + chrono::Duration::days(meeting as i64);
        let created = format!("{day}T09:00:00.000000+00:00");
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at, group_id) VALUES (?, ?, ?, ?, ?)")
            .bind(&id)
            .bind(format!("Планёрка {meeting}: {}", words.sentence(3)))
            .bind(&created)
            .bind(&created)
            .bind(format!("g{}", meeting % GROUPS))
            .execute(&mut *tx)
            .await
            .unwrap();
        for line in 0..LINES_PER_MEETING {
            let start = line as f64 * 7.2;
            sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(format!("{id}-{line:04}"))
            .bind(&id)
            .bind(words.sentence(12 + line % 9))
            .bind(&created)
            .bind(if line % 4 == 0 { "You".to_string() } else { format!("Speaker {}", line % 3 + 1) })
            .bind(start)
            .bind(start + 6.8)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
        for speaker in 0..3 {
            sqlx::query("INSERT INTO person_speakers (person_id, meeting_id, speaker_label) VALUES (?, ?, ?)")
                .bind(format!("p{}", (meeting + speaker * 7) % PEOPLE))
                .bind(&id)
                .bind(format!("Speaker {}", speaker + 1))
                .execute(&mut *tx)
                .await
                .unwrap();
        }
        let summary = serde_json::json!({ "markdown": format!("## Итоги\n\n{}\n\n## Решения\n\n- {}\n- {}", words.sentence(150), words.sentence(20), words.sentence(20)) });
        sqlx::query("INSERT INTO summary_processes (meeting_id, status, created_at, updated_at, result) VALUES (?, 'completed', ?, ?, ?)")
            .bind(&id)
            .bind(&created)
            .bind(&created)
            .bind(summary.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
        for item in 0..3 {
            sqlx::query(
                "INSERT INTO action_items (id, meeting_id, text, owner_label, person_id, done, source, position, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?)",
            )
            .bind(format!("{id}-a{item}"))
            .bind(&id)
            .bind(words.sentence(8))
            .bind(format!("Сотрудник {}", (meeting + item) % PEOPLE))
            .bind(format!("p{}", (meeting + item) % PEOPLE))
            .bind((meeting + item) % 2 == 0)
            .bind(item as i64)
            .bind(&created)
            .bind(&created)
            .execute(&mut *tx)
            .await
            .unwrap();
        }
    }
    tx.commit().await.unwrap();
    pool.close().await;
    fixture
}

async fn measure<F, Fut>(library: &Library, name: &str, call: F)
where
    F: Fn(sqlx::pool::PoolConnection<sqlx::Sqlite>) -> Fut,
    Fut: Future<Output = Result<String, Problem>>,
{
    let mut times = Vec::new();
    let mut outcome = String::new();
    for _ in 0..3 {
        let session = library.session().await.unwrap();
        let started = Instant::now();
        let result = call(session.conn).await;
        times.push(started.elapsed());
        outcome = match result {
            Ok(text) => format!("{} tokens est., {} chars", estimated_tokens(&text), text.chars().count()),
            Err(problem) => format!("error: {problem:?}"),
        };
    }
    times.sort();
    println!("| {name} | {:.0} | {:.0} | {outcome} |", times[1].as_secs_f64() * 1000.0, times[2].as_secs_f64() * 1000.0);
}

#[tokio::test]
#[ignore = "builds a 150,000-line library; run with --ignored for the numbers"]
async fn the_heaviest_calls_on_a_large_library() {
    let built = Instant::now();
    let fixture = build().await;
    let size = std::fs::metadata(&fixture.db).unwrap().len();
    println!(
        "library: {MEETINGS} meetings × {LINES_PER_MEETING} lines, {:.1} MB, built in {:.0} s",
        size as f64 / 1_048_576.0,
        built.elapsed().as_secs_f64()
    );
    let library = fixture.library();
    println!("| call | median ms | worst ms | result |\n|---|---|---|---|");

    measure(&library, "list_meetings, 100 per page", |mut conn| async move {
        tools::list_meetings(&mut conn, ListMeetingsArgs { limit: Some(100), ..Default::default() }).await
    })
    .await;
    measure(&library, "list_meetings, person + dates", |mut conn| async move {
        tools::list_meetings(
            &mut conn,
            ListMeetingsArgs { person: Some("p3".into()), from: Some("2026-03-01".into()), to: Some("2026-09-30".into()), ..Default::default() },
        )
        .await
    })
    .await;
    measure(&library, "get_meeting with transcript", |mut conn| async move {
        tools::get_meeting(&mut conn, GetMeetingArgs { meeting_id: "m150".into(), include_transcript: Some(true) }).await
    })
    .await;
    measure(&library, "get_transcript, first page", |mut conn| async move {
        tools::get_transcript(&mut conn, GetTranscriptArgs { meeting_id: "m299".into(), offset: None, limit: Some(500) }).await
    })
    .await;
    measure(&library, "get_transcript, last page", |mut conn| async move {
        tools::get_transcript(&mut conn, GetTranscriptArgs { meeting_id: "m000".into(), offset: Some(450), limit: Some(500) }).await
    })
    .await;
    measure(&library, "search, common word", |mut conn| async move {
        tools::search(&mut conn, SearchArgs { query: "бюджет".into(), limit: Some(50), ..Default::default() }).await
    })
    .await;
    measure(&library, "search, no match (full scan)", |mut conn| async move {
        tools::search(&mut conn, SearchArgs { query: "несуществующее".into(), ..Default::default() }).await
    })
    .await;
    measure(&library, "search, deep page", |mut conn| async move {
        tools::search(&mut conn, SearchArgs { query: "budget".into(), offset: Some(150), limit: Some(50), ..Default::default() }).await
    })
    .await;
    measure(&library, "search, one group", |mut conn| async move {
        tools::search(&mut conn, SearchArgs { query: "бюджет".into(), group: Some("g4".into()), ..Default::default() }).await
    })
    .await;
    measure(&library, "get_action_items, open, all meetings", |mut conn| async move {
        tools::get_action_items(&mut conn, GetActionItemsArgs { limit: Some(200), ..Default::default() }).await
    })
    .await;
    measure(&library, "list_people, 200 per page", |mut conn| async move {
        tools::list_people(&mut conn, ListPeopleArgs { limit: Some(200), ..Default::default() }).await
    })
    .await;
    measure(&library, "list_groups", |mut conn| async move {
        tools::list_groups(&mut conn, ListGroupsArgs::default()).await
    })
    .await;

    // The app saves a meeting's transcript while the slowest search runs.
    let session = library.session().await.unwrap();
    let reader = tokio::spawn(async move {
        let mut conn = session.conn;
        let started = Instant::now();
        let result = tools::search(&mut conn, SearchArgs { query: "несуществующее".into(), ..Default::default() }).await;
        (result.map(|_| ()), started.elapsed())
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    let app = writer(&fixture.db, false).await;
    let started = Instant::now();
    let mut tx = app.begin().await.unwrap();
    for line in 0..LINES_PER_MEETING {
        sqlx::query("INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time) VALUES (?, 'm000', 'saved on Stop', '2026-01-01T10:00:00Z', 'You', ?)")
            .bind(format!("save-{line}"))
            .bind(line as f64)
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    tx.commit().await.expect("the app's save must commit");
    let waited = started.elapsed();
    let (search, searched) = reader.await.unwrap();
    println!(
        "app save of {LINES_PER_MEETING} lines during the no-match search: committed after {:.0} ms; the search took {:.0} ms ({:?})",
        waited.as_secs_f64() * 1000.0,
        searched.as_secs_f64() * 1000.0,
        search.err()
    );
    assert!(waited < Duration::from_secs(5), "the app's save would have failed");
    app.close().await;
}
