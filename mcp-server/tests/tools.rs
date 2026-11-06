//! What each tool answers on a known library.

mod common;

use chrono::{Local, NaiveDate, TimeZone, Utc};
use common::Fixture;
use protocol_mcp::store::Problem;
use protocol_mcp::text::{estimated_tokens, RESULT_CHARS, RESULT_TOKENS};
use protocol_mcp::tools::{self, *};

async fn list_meetings(fixture: &Fixture, args: ListMeetingsArgs) -> String {
    let mut session = fixture.session().await;
    tools::list_meetings(&mut session.conn, args).await.unwrap()
}

fn order(text: &str, ids: &[&str]) {
    let positions: Vec<usize> = ids
        .iter()
        .map(|id| text.find(&format!("id {id} ")).unwrap_or_else(|| panic!("{id} missing in:\n{text}")))
        .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "order {ids:?} in:\n{text}");
}

#[tokio::test]
async fn meetings_come_newest_first_and_never_include_a_deleted_one() {
    let fixture = Fixture::new().await;
    let text = list_meetings(&fixture, ListMeetingsArgs::default()).await;
    assert!(text.starts_with("Meetings 1–4 of 4, newest first."), "{text}");
    order(&text, &["m4", "m3", "m2", "m1"]);
    assert!(!text.contains("deleted"), "{text}");
    assert!(!text.contains("More:"), "{text}");

    let m1 = text.lines().find(|line| line.contains("id m1 ")).unwrap();
    assert!(m1.contains("\"Budget review\""), "{m1}");
    assert!(m1.contains("1 min · 4 transcript lines"), "{m1}");
    assert!(m1.contains("group \"Budget committee\" (g1)"), "{m1}");
    assert!(m1.contains("people: Alice"), "{m1}");
    assert!(m1.ends_with("· summary"), "{m1}");
    let m4 = text.lines().find(|line| line.contains("id m4 ")).unwrap();
    assert!(m4.contains("no transcript") && m4.ends_with("· no summary"), "{m4}");
}

#[tokio::test]
async fn meetings_filter_by_person_group_title_and_page() {
    let fixture = Fixture::new().await;

    let by_person = list_meetings(&fixture, ListMeetingsArgs { person: Some("alice".into()), ..Default::default() }).await;
    assert!(by_person.contains("Person \"alice\" matched: Alice (p1)."), "{by_person}");
    order(&by_person, &["m3", "m1"]);
    assert!(!by_person.contains("id m2 ") && !by_person.contains("id m4 "), "{by_person}");

    let by_group = list_meetings(&fixture, ListMeetingsArgs { group: Some("клиент".into()), ..Default::default() }).await;
    assert!(by_group.contains("id m2 ") && by_group.contains("1–1 of 1"), "{by_group}");

    let by_title = list_meetings(&fixture, ListMeetingsArgs { title: Some("RETRO".into()), ..Default::default() }).await;
    assert!(by_title.contains("id m3 ") && by_title.contains("1–1 of 1"), "{by_title}");

    let nobody = list_meetings(&fixture, ListMeetingsArgs { person: Some("Zed".into()), ..Default::default() }).await;
    assert!(nobody.starts_with("No contact matches \"Zed\"."), "{nobody}");

    let first = list_meetings(&fixture, ListMeetingsArgs { limit: Some(2), ..Default::default() }).await;
    assert!(first.contains("1–2 of 4"), "{first}");
    assert!(first.ends_with("More: call list_meetings again with offset=2 and the same other arguments."), "{first}");
    let second = list_meetings(&fixture, ListMeetingsArgs { limit: Some(2), offset: Some(2), ..Default::default() }).await;
    order(&second, &["m2", "m1"]);
    assert!(!second.contains("More:"), "{second}");
}

/// `from`/`to` days are this computer's calendar days: a meeting at 00:30
/// local time belongs to that day even where it is the previous day in UTC.
#[tokio::test]
async fn date_filters_use_local_days() {
    let at = |day: u32, hour: u32, minute: u32| {
        Local
            .from_local_datetime(&NaiveDate::from_ymd_opt(2026, 10, day).unwrap().and_hms_opt(hour, minute, 0).unwrap())
            .earliest()
            .unwrap()
            .with_timezone(&Utc)
            .to_rfc3339()
    };
    let rows = format!(
        "INSERT INTO meetings (id, title, created_at, updated_at) VALUES \
         ('late', 'Late on the 1st', '{late}', '{late}'), \
         ('early', 'Early on the 2nd', '{early}', '{early}'), \
         ('legacy', 'Legacy format', '{legacy}', '{legacy}');",
        late = at(1, 23, 30),
        early = at(2, 0, 30),
        // Old rows: `YYYY-MM-DD HH:MM:SS` in UTC.
        legacy = Local
            .from_local_datetime(&NaiveDate::from_ymd_opt(2026, 10, 2).unwrap().and_hms_opt(12, 0, 0).unwrap())
            .earliest()
            .unwrap()
            .with_timezone(&Utc)
            .format("%Y-%m-%d %H:%M:%S"),
    );
    let fixture = Fixture::with(&rows).await;
    let day = |from: &str, to: &str| ListMeetingsArgs {
        from: Some(from.into()),
        to: Some(to.into()),
        ..Default::default()
    };
    let second = list_meetings(&fixture, day("2026-10-02", "2026-10-02")).await;
    assert!(second.contains("id early ") && second.contains("id legacy "), "{second}");
    assert!(!second.contains("id late "), "{second}");
    let first = list_meetings(&fixture, day("2026-10-01", "2026-10-01")).await;
    assert!(first.contains("id late ") && first.contains("1–1 of 1"), "{first}");
    let line = first.lines().find(|line| line.contains("id late ")).unwrap();
    assert!(line.contains("2026-10-01 23:30"), "local time shown: {line}");

    let mut session = fixture.session().await;
    let bad = tools::list_meetings(&mut session.conn, ListMeetingsArgs { from: Some("01.10.2026".into()), ..Default::default() })
        .await
        .unwrap_err();
    assert!(bad.message().contains("2026-10-01"), "{}", bad.message());
}

#[tokio::test]
async fn a_meeting_reads_in_full_without_private_contact_fields() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;
    let text = tools::get_meeting(&mut session.conn, GetMeetingArgs { meeting_id: "m1".into(), include_transcript: None })
        .await
        .unwrap();
    assert!(text.starts_with("# Budget review\nid m1 · "), "{text}");
    assert!(text.contains("group \"Budget committee\" (g1)"), "{text}");
    assert!(text.contains("Contacts: Alice (p1; labelled Speaker 2)"), "{text}");
    assert!(
        text.contains("Speaker labels in the transcript: Speaker 2 (1 lines), You (2 lines), Alice + Speaker 2 (1 lines)"),
        "{text}"
    );
    assert!(text.contains("## Your notes\nRemember the travel freeze"), "{text}");
    assert!(text.contains("- [ ] Send the budget to finance · owner Alice (p1) · due Friday · id a1"), "{text}");
    assert!(text.contains("- [x] Book the room · owner You · id a2"), "{text}");
    assert!(text.contains("## AI summary\nThe user edited it.\n## Decisions\n- Budget cut approved"), "{text}");
    assert!(text.ends_with("4 lines; read them with get_transcript (meeting_id=m1)."), "{text}");
    for hidden in ["cache text", "private note", "555", "alice@example.com", "Ghost"] {
        assert!(!text.contains(hidden), "{hidden} leaked:\n{text}");
    }

    let with_lines = tools::get_meeting(&mut session.conn, GetMeetingArgs { meeting_id: "m1".into(), include_transcript: Some(true) })
        .await
        .unwrap();
    assert!(
        with_lines.contains(
            "## Transcript (1–4 of 4)\n\
             [00:12–00:15] Speaker 2: We need to cut the budget by ten percent\n\
             [00:16–00:17] You: Agreed.\n\
             [00:18–00:20] And travel too.\n\
             [00:21–00:25] Alice + Speaker 2: Fine by me, the budget forecast can wait"
        ),
        "{with_lines}"
    );

    for missing in ["nope", "deleted-meeting"] {
        let error = tools::get_meeting(&mut session.conn, GetMeetingArgs { meeting_id: missing.into(), include_transcript: None })
            .await
            .unwrap_err();
        assert!(matches!(error, Problem::NotFound(_)), "{missing}: {error:?}");
    }
}

#[tokio::test]
async fn transcripts_page_and_label_each_page_from_its_first_line() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;
    let page = |offset, limit| GetTranscriptArgs { meeting_id: "m1".into(), offset, limit };

    let first = tools::get_transcript(&mut session.conn, page(None, Some(2))).await.unwrap();
    assert!(first.starts_with("Transcript of \"Budget review\" (id m1), lines 1–2 of 4."), "{first}");
    assert!(first.ends_with("[00:16–00:17] You: Agreed.\nMore: call get_transcript again with offset=2 and the same other arguments."), "{first}");

    let second = tools::get_transcript(&mut session.conn, page(Some(2), Some(2))).await.unwrap();
    assert!(second.contains("lines 3–4 of 4"), "{second}");
    // The page starts mid-turn: the label is repeated so the page reads alone.
    assert!(second.contains("\n[00:18–00:20] You: And travel too.\n"), "{second}");
    assert!(!second.contains("More:"), "{second}");

    let russian = tools::get_transcript(&mut session.conn, GetTranscriptArgs { meeting_id: "m2".into(), offset: None, limit: None })
        .await
        .unwrap();
    assert!(russian.contains("[00:03–00:06] Speaker 1: Бюджет утвердили, budget is final\n[00:07–00:09] Guest: обсудили бюджет на квартал"), "{russian}");
}

/// A long Russian meeting: every page stays inside the result budget, pages
/// cover every line exactly once, and the paging line is never cut off.
#[tokio::test]
async fn long_russian_transcripts_fit_the_result_budget() {
    let line = "Коллеги, давайте ещё раз пройдёмся по бюджету на следующий квартал и решим, что сокращаем первым.";
    let mut rows = String::from(
        "INSERT INTO meetings (id, title, created_at, updated_at) VALUES ('big', 'Большая планёрка', '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z');\n",
    );
    for index in 0..1_500 {
        rows.push_str(&format!(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time) \
             VALUES ('r{index:04}', 'big', '{line} {index}', '2026-10-05T09:00:00Z', 'Speaker {}', {}, {});\n",
            index % 3 + 1,
            index * 4,
            index * 4 + 3
        ));
    }
    let fixture = Fixture::with(&rows).await;
    let mut session = fixture.session().await;
    let mut offset = 0u32;
    let mut seen = 0;
    let mut pages = 0;
    loop {
        let text = tools::get_transcript(
            &mut session.conn,
            GetTranscriptArgs { meeting_id: "big".into(), offset: Some(offset), limit: Some(500) },
        )
        .await
        .unwrap();
        assert!(estimated_tokens(&text) <= RESULT_TOKENS, "page at {offset}: {} tokens", estimated_tokens(&text));
        assert!(text.chars().count() <= RESULT_CHARS);
        let lines = text.lines().filter(|line| line.starts_with('[')).count();
        assert!(lines > 50, "page at {offset} has only {lines} lines");
        let first = text.lines().find(|text| text.starts_with('[')).unwrap();
        assert!(first.ends_with(&format!("{line} {seen}")), "page at {offset} starts with {first}");
        seen += lines;
        pages += 1;
        match text.lines().last().and_then(|last| last.strip_prefix("More: call get_transcript again with offset=")) {
            Some(rest) => offset = rest.split(' ').next().unwrap().parse().unwrap(),
            None => break,
        }
        assert_eq!(offset as usize, seen);
        // A fresh session per page, as separate tool calls get.
        session = fixture.session().await;
    }
    assert_eq!(seen, 1_500);
    assert!(pages > 2, "{pages} pages");
}

#[tokio::test]
async fn summaries_read_as_markdown_with_their_status() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;
    let summary = |id: &str| GetSummaryArgs { meeting_id: id.into() };

    let blocknote = tools::get_summary(&mut session.conn, summary("m2")).await.unwrap();
    assert!(blocknote.contains("\n\n## Итоги\n\n- Бюджет согласован") || blocknote.contains("## Итоги\n- Бюджет согласован"), "{blocknote}");
    let pending = tools::get_summary(&mut session.conn, summary("m3")).await.unwrap();
    assert!(pending.contains("A new summary is being generated; this is the previous one.\n\nRetro notes"), "{pending}");
    let failed = tools::get_summary(&mut session.conn, summary("m4")).await.unwrap();
    assert!(failed.contains("Generating a summary failed (model not downloaded).\n\n(no summary text)"), "{failed}");
    let deleted = tools::get_summary(&mut session.conn, summary("deleted-meeting")).await.unwrap_err();
    assert!(matches!(deleted, Problem::NotFound(_)));
}

#[tokio::test]
async fn action_items_across_meetings_and_for_one() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;

    let open = tools::get_action_items(&mut session.conn, GetActionItemsArgs::default()).await.unwrap();
    assert!(open.starts_with("Open action items across meetings, newest meeting first: 1–2 of 2."), "{open}");
    let a3 = open.find("Close the budget ticket").unwrap();
    let a1 = open.find("Send the budget to finance").unwrap();
    assert!(a3 < a1, "{open}");
    assert!(open.contains("meeting \"Budget review\" (m1, "), "{open}");
    assert!(!open.contains("Book the room") && !open.contains("Ghost"), "{open}");

    let bob = tools::get_action_items(&mut session.conn, GetActionItemsArgs { person: Some("Bob".into()), status: Some("all".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(bob.contains("Owner \"Bob\" matched: Bob (p2).") && bob.contains("1–1 of 1") && bob.contains("Close the budget ticket"), "{bob}");

    let one = tools::get_action_items(&mut session.conn, GetActionItemsArgs { meeting_id: Some("m1".into()), ..Default::default() })
        .await
        .unwrap();
    assert!(one.starts_with("Action items of \"Budget review\" (id m1): 1–2 of 2."), "{one}");
    assert!(one.find("Send the budget").unwrap() < one.find("Book the room").unwrap(), "{one}");
    assert!(!one.contains("meeting \""), "one meeting's items do not repeat it: {one}");

    let bad = tools::get_action_items(&mut session.conn, GetActionItemsArgs { status: Some("later".into()), ..Default::default() })
        .await
        .unwrap_err();
    assert!(matches!(bad, Problem::BadArgument(_)));
}

#[tokio::test]
async fn search_ranks_like_ctrl_k_and_points_into_the_transcript() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;
    let text = tools::search(&mut session.conn, SearchArgs { query: "budget".into(), ..Default::default() }).await.unwrap();
    assert!(text.contains("- transcript · meeting \"Budget review\" (m1, "), "{text}");
    assert!(text.contains("at 00:12, line 1, offset 0 · Speaker 2: \"We need to cut the budget by ten percent\""), "{text}");
    assert!(text.contains("at 00:21, line 4, offset 3 · Alice + Speaker 2: "), "{text}");
    assert!(text.contains("pass a result's offset to get_transcript"), "{text}");
    assert!(text.contains("- group \"Budget committee\" · id g1 · 2 meetings"), "{text}");
    for hidden in ["deleted meeting", "Ghost", "cache text"] {
        assert!(!text.contains(hidden), "{hidden} leaked:\n{text}");
    }

    let scoped = tools::search(
        &mut session.conn,
        SearchArgs { query: "budget".into(), group: Some("g2".into()), ..Default::default() },
    )
    .await
    .unwrap();
    assert!(scoped.contains("Планёрка по бюджету") && !scoped.contains("Budget review"), "{scoped}");
    assert!(!scoped.contains("- group ") && !scoped.contains("- person "), "{scoped}");

    let actions = tools::search(
        &mut session.conn,
        SearchArgs { query: "budget".into(), kinds: Some(vec!["action".into()]), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(actions.lines().filter(|line| line.starts_with("- ")).count(), 2, "{actions}");
    assert!(actions.contains("- action item \"Send the budget to finance\" · owner Alice"), "{actions}");

    let person = tools::search(&mut session.conn, SearchArgs { query: "alice".into(), ..Default::default() }).await.unwrap();
    assert!(person.contains("- person Alice · id p1\n") || person.ends_with("- person Alice · id p1"), "{person}");
    assert!(!person.contains("private note"), "{person}");

    let paged = tools::search(&mut session.conn, SearchArgs { query: "budget".into(), limit: Some(2), ..Default::default() })
        .await
        .unwrap();
    assert!(paged.ends_with("More: call search again with offset=2 and the same other arguments."), "{paged}");

    let unknown = tools::search(
        &mut session.conn,
        SearchArgs { query: "budget".into(), kinds: Some(vec!["email".into()]), ..Default::default() },
    )
    .await
    .unwrap_err();
    assert!(matches!(unknown, Problem::BadArgument(_)));
    let blank = tools::search(&mut session.conn, SearchArgs { query: "  ".into(), ..Default::default() }).await.unwrap_err();
    assert!(matches!(blank, Problem::BadArgument(_)));
}

/// Capitalised Cyrillic is found whatever case the query is typed in (#8);
/// SQLite's own lower() missed "Бюджет" at the start of a line.
#[tokio::test]
async fn capitalised_cyrillic_is_found_in_any_case() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;
    for query in ["бюджет", "БЮДЖЕТ", "Бюджет"] {
        let text = tools::search(
            &mut session.conn,
            SearchArgs { query: query.into(), kinds: Some(vec!["transcript".into()]), ..Default::default() },
        )
        .await
        .unwrap();
        assert!(text.contains("line 1, offset 0 · Speaker 1: \"Бюджет утвердили, budget is final\""), "{query}:\n{text}");
        assert!(text.contains("line 2, offset 1 · Guest: \"обсудили бюджет на квартал\""), "{query}:\n{text}");
    }
    drop(session);

    let by_title = list_meetings(&fixture, ListMeetingsArgs { title: Some("ПЛАНЁРКА".into()), ..Default::default() }).await;
    assert!(by_title.contains("id m2 ") && by_title.contains("1–1 of 1"), "{by_title}");
}

/// One meeting with more hits than a page, as a common Russian word in a long
/// meeting gives: 30 lines, 12 action items (open and done mixed) and the
/// title. Following "More" page by page returns the same hits, in the same
/// order, as one page holding them all; each kind used to rank only its first
/// rows, so later pages repeated earlier hits and never reached the rest.
#[tokio::test]
async fn search_pages_slice_one_ranking() {
    let lines: Vec<String> = (0..30)
        .map(|i| {
            format!(
                "('long-{i:02}', 'long', 'Бюджет, пункт {i}', '2026-10-05T09:{i:02}:00Z', 'Speaker {}', {}.0, {}.5)",
                i % 3 + 1,
                i * 60,
                i * 60
            )
        })
        .collect();
    let actions: Vec<String> = (0..12)
        .map(|i| {
            format!(
                "('act-{i:02}', 'long', 'Бюджет: задача {i}', NULL, NULL, NULL, {}, 'ai', {i}, \
                 '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z')",
                i % 2
            )
        })
        .collect();
    let rows = format!(
        "{}\nINSERT INTO meetings (id, title, created_at, updated_at) VALUES \
         ('long', 'Квартальный бюджет', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z');\n\
         INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time) VALUES {};\n\
         INSERT INTO action_items (id, meeting_id, text, owner_label, person_id, due_text, done, source, position, created_at, updated_at) VALUES {};\n",
        common::LIBRARY,
        lines.join(", "),
        actions.join(", ")
    );
    let fixture = Fixture::with(&rows).await;
    let mut session = fixture.session().await;
    let hits = |text: &str| -> Vec<String> {
        text.lines().filter(|line| line.starts_with("- ")).map(str::to_string).collect()
    };

    let whole = tools::search(&mut session.conn, SearchArgs { query: "бюджет".into(), limit: Some(50), ..Default::default() })
        .await
        .unwrap();
    let whole = hits(&whole);
    // 2 titles, 32 lines, 12 action items, 1 summary.
    assert_eq!(whole.len(), 47, "{whole:#?}");

    let mut paged = Vec::new();
    let mut pages = 0;
    let mut offset = 0;
    loop {
        let text = tools::search(
            &mut session.conn,
            SearchArgs { query: "бюджет".into(), limit: Some(10), offset: Some(offset), ..Default::default() },
        )
        .await
        .unwrap();
        pages += 1;
        let page = hits(&text);
        assert!(text.starts_with(&format!("Results for \"бюджет\" {}–{},", offset + 1, offset as usize + page.len())), "{text}");
        paged.extend(page);
        match text.lines().last().and_then(|line| line.strip_prefix("More: call search again with offset=")) {
            Some(rest) => offset = rest.split(' ').next().unwrap().parse().unwrap(),
            None => break,
        }
    }
    assert_eq!(pages, 5);
    assert_eq!(paged, whole);
    for i in 0..30 {
        let line = format!("offset {i} · Speaker {}: \"Бюджет, пункт {i}\"", i % 3 + 1);
        assert_eq!(paged.iter().filter(|hit| hit.contains(&line)).count(), 1, "{line}");
    }
}

/// A page the token budget cuts short counts in its header only the rows it
/// shows; it used to count every row read ("1–100") above 20-odd rows.
#[tokio::test]
async fn a_page_cut_by_the_budget_counts_what_it_shows() {
    let meetings: Vec<String> = (0..100)
        .map(|i| {
            format!(
                "('long-{i:03}', '{}', '2026-09-{:02}T09:00:00Z', '2026-09-01T10:00:00Z')",
                format!("Совещание {i} ").repeat(40),
                i % 28 + 1
            )
        })
        .collect();
    let rows = format!(
        "{}\nINSERT INTO meetings (id, title, created_at, updated_at) VALUES {};\n",
        common::LIBRARY,
        meetings.join(", ")
    );
    let fixture = Fixture::with(&rows).await;
    let text = list_meetings(&fixture, ListMeetingsArgs { limit: Some(100), ..Default::default() }).await;
    let shown = text.lines().filter(|line| line.starts_with("- ")).count();
    assert!(shown > 0 && shown < 100, "{shown} rows:\n{text}");
    assert!(text.starts_with(&format!("Meetings 1–{shown} of 104,")), "{shown} rows:\n{text}");
    assert!(text.ends_with(&format!("offset={shown} and the same other arguments.")), "{text}");
    assert!(estimated_tokens(&text) <= RESULT_TOKENS, "{}", estimated_tokens(&text));
}

#[tokio::test]
async fn people_and_groups_list_without_phone_or_notes() {
    let fixture = Fixture::new().await;
    let mut session = fixture.session().await;
    let people = tools::list_people(&mut session.conn, ListPeopleArgs::default()).await.unwrap();
    assert!(people.starts_with("Contacts 1–3 of 3, by name."), "{people}");
    let alice = people.lines().find(|line| line.starts_with("- Alice")).unwrap();
    assert!(alice.contains("id p1 · alice@example.com · Acme · PM · 2 meetings, last "), "{alice}");
    assert!(alice.contains("groups: \"Budget committee\" (g1, 2)"), "{alice}");
    for hidden in ["555", "private note", "Finance lead"] {
        assert!(!people.contains(hidden), "{hidden} leaked:\n{people}");
    }
    assert!(people.contains("- Борис · id p3 · no meetings"), "{people}");
    let filtered = tools::list_people(&mut session.conn, ListPeopleArgs { name: Some("БОР".into()), ..Default::default() }).await.unwrap();
    assert!(filtered.contains("1–1 of 1") && filtered.contains("Борис"), "{filtered}");

    let groups = tools::list_groups(&mut session.conn, ListGroupsArgs::default()).await.unwrap();
    assert!(groups.contains("- \"Budget committee\" · id g1 · team · 2 meetings, last "), "{groups}");
    assert!(groups.contains("Monthly budget review"), "{groups}");
    assert!(groups.contains("- \"Клиент Альфа\" · id g2 · client · 1 meeting, last "), "{groups}");
}
