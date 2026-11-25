use crate::api::TranscriptSegment;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use sqlx::{Connection, Error as SqlxError, SqlitePool};
use tracing::{error, info};
use uuid::Uuid;

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    /// `title_is_manual` is the caller's record of whether the user chose the
    /// title (#218): the title's text is never read for it, so the automatic
    /// format can change (#219) without making a title look like the user's.
    pub async fn save_transcript(
        pool: &SqlitePool,
        meeting_title: &str,
        title_is_manual: bool,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
        recording_started_at: Option<DateTime<Utc>>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();
        let recording_started_at = recording_started_at.unwrap_or(now);

        // 1. Create the new meeting
        let result = sqlx::query(
            "INSERT INTO meetings
             (id, title, created_at, updated_at, folder_path, title_is_manual)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&meeting_id)
        .bind(meeting_title)
        .bind(recording_started_at)
        .bind(now)
        .bind(&folder_path)
        .bind(title_is_manual)
        .execute(&mut *transaction)
        .await;

        if let Err(e) = result {
            error!("Failed to create meeting '{}': {}", meeting_title, e);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let timestamp = match segment.audio_start_time {
                Some(offset) => timestamp_from_offset(recording_started_at, offset)?,
                None => segment.timestamp.clone(),
            };
            let result = sqlx::query(
                // `speaker` must be persisted: the offline diarization pass
                // finds the local user by matching the live "You" ranges, so
                // omitting it here erased the user's identity from every
                // meeting the moment it was saved.
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
            .bind(&segment.speaker)
            .execute(&mut *transaction)
            .await;

            if let Err(e) = result {
                error!(
                    "Failed to save transcript segment for meeting {}: {}",
                    meeting_id, e
                );
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        crate::database::repositories::person::PeopleRepository::link_named_speakers(
            &mut transaction,
            &meeting_id,
        )
        .await?;

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }
}

pub(crate) fn timestamp_from_offset(
    recording_started_at: DateTime<Utc>,
    offset_seconds: f64,
) -> Result<String, SqlxError> {
    if !offset_seconds.is_finite() || offset_seconds < 0.0 {
        return Err(SqlxError::Protocol(format!(
            "invalid transcript audio offset: {offset_seconds}"
        )));
    }

    let micros = offset_seconds * 1_000_000.0;
    if micros > i64::MAX as f64 {
        return Err(SqlxError::Protocol(format!(
            "transcript audio offset is too large: {offset_seconds}"
        )));
    }

    recording_started_at
        .checked_add_signed(Duration::microseconds(micros.round() as i64))
        .ok_or_else(|| {
            SqlxError::Protocol(format!(
                "transcript timestamp overflow for offset: {offset_seconds}"
            ))
        })
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn save_links_live_named_speaker_for_enrollment() {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, folder_path TEXT, title_is_manual INTEGER); \
             CREATE TABLE transcripts (id TEXT PRIMARY KEY, meeting_id TEXT, transcript TEXT, timestamp TEXT, audio_start_time REAL, audio_end_time REAL, duration REAL, speaker TEXT); \
             CREATE TABLE people (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, normalized_name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); \
             CREATE TABLE person_speakers (person_id TEXT NOT NULL, meeting_id TEXT NOT NULL, speaker_label TEXT NOT NULL, UNIQUE(meeting_id, speaker_label));"
        ).execute(&pool).await.unwrap();
        let make_turn = |speaker: &str| TranscriptSegment {
            id: "unused".into(), text: "Hello".into(), timestamp: "2026-09-27T00:00:00Z".into(),
            audio_start_time: Some(0.0), audio_end_time: Some(2.0), duration: Some(2.0),
            speaker: Some(speaker.into()),
        };
        let meeting = TranscriptsRepository::save_transcript(&pool, "Test", true, &[make_turn("Alice"), make_turn("Speaker 2")], None, None)
            .await.unwrap();
        let linked: Vec<String> = sqlx::query_scalar("SELECT speaker_label FROM person_speakers WHERE meeting_id = ?")
            .bind(meeting).fetch_all(&pool).await.unwrap();
        assert_eq!(linked, vec!["Alice"]);
    }

    /// The caller's record decides, never the title's text (#218): an
    /// automatic-looking title the user typed stays theirs, and a title the
    /// app made in any format is not.
    #[tokio::test]
    async fn save_keeps_the_callers_record_of_whose_title_it_is() {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        let typed = TranscriptsRepository::save_transcript(&pool, "Meeting · Mon, Sep 28 · 2:30 PM", true, &[], None, None)
            .await.unwrap();
        let made = TranscriptsRepository::save_transcript(&pool, "Weekly Standup — Sep 28", false, &[], None, None)
            .await.unwrap();
        for (id, manual) in [(typed, true), (made, false)] {
            let stored: bool = sqlx::query_scalar("SELECT title_is_manual FROM meetings WHERE id = ?")
                .bind(&id).fetch_one(&pool).await.unwrap();
            assert_eq!(stored, manual, "{id}");
        }
    }

    #[test]
    fn timestamp_uses_recording_start_and_fractional_offset() {
        let start = DateTime::parse_from_rfc3339("2026-08-30T23:59:50Z")
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(
            timestamp_from_offset(start, 14.97).unwrap(),
            "2026-08-31T00:00:04.970Z"
        );
    }

    #[test]
    fn timestamp_rejects_invalid_offsets() {
        let start = Utc::now();
        assert!(timestamp_from_offset(start, -1.0).is_err());
        assert!(timestamp_from_offset(start, f64::NAN).is_err());
        assert!(timestamp_from_offset(start, f64::INFINITY).is_err());
    }
}
