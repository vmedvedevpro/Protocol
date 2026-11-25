//! Renaming a meeting (#218): the one path for a rename by the user and for
//! the title a summary writes. The database is the record
//! (`MeetingsRepository::set_title`, which also decides whether a summary's
//! title may apply); the meeting's folder keeps its name, as a manual rename
//! always left it, and its `metadata.json` gets the new `meeting_name`.

use std::path::Path;

use sqlx::SqlitePool;
use tracing::{error, info};

use crate::database::repositories::meeting::{MeetingsRepository, TitleSource};
use crate::summary::metadata::write_meeting_name_to_metadata;

/// Answers whether the title changed: false for a meeting that does not
/// exist, and for a summary's title when the user's title stands.
pub async fn rename_meeting(
    pool: &SqlitePool,
    meeting_id: &str,
    title: &str,
    source: TitleSource,
) -> Result<bool, sqlx::Error> {
    if !MeetingsRepository::set_title(pool, meeting_id, title, source).await? {
        return Ok(false);
    }
    let folder: Option<Option<String>> = sqlx::query_scalar("SELECT folder_path FROM meetings WHERE id = ?")
        .bind(meeting_id)
        .fetch_optional(pool)
        .await?;
    if let Some(folder) = folder.flatten().filter(|folder| !folder.trim().is_empty()) {
        // The database already holds the title; a folder that cannot take it
        // is reported, not undone, since the app reads titles from the database.
        match write_meeting_name_to_metadata(Path::new(&folder), title.trim()) {
            Ok(true) => info!("Wrote the new title of {meeting_id} into {folder}/metadata.json"),
            Ok(false) => {}
            Err(problem) => error!("Renamed {meeting_id}, but could not write the title into {folder}/metadata.json: {problem:#}"),
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool(folder: &Path) -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path, title_is_manual) VALUES \
             ('auto', 'Meeting at 9:30', '2026-11-26', '2026-11-26', ?, 0), \
             ('mine', 'Budget sync', '2026-11-26', '2026-11-26', NULL, 1)",
        )
        .bind(folder.to_string_lossy().to_string())
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn title(pool: &SqlitePool, id: &str) -> (String, bool) {
        sqlx::query_as("SELECT title, title_is_manual FROM meetings WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_summary_names_an_automatic_title_and_the_folder_follows() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("metadata.json"), r#"{"meeting_name":"Meeting at 9:30","version":"1.0"}"#).unwrap();
        let pool = pool(dir.path()).await;

        assert!(rename_meeting(&pool, "auto", " Q4 budget review ", TitleSource::Summary).await.unwrap());
        assert_eq!(title(&pool, "auto").await, ("Q4 budget review".to_string(), false), "still not the user's");
        let metadata: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("metadata.json")).unwrap()).unwrap();
        assert_eq!(metadata["meeting_name"], "Q4 budget review");
        assert_eq!(metadata["version"], "1.0");

        // A rerun of the summary names it again while it is not the user's.
        assert!(rename_meeting(&pool, "auto", "Budget review, second pass", TitleSource::Summary).await.unwrap());
        assert_eq!(title(&pool, "auto").await.0, "Budget review, second pass");
    }

    #[tokio::test]
    async fn a_title_the_user_set_is_never_replaced_by_a_summary() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(dir.path()).await;
        assert!(!rename_meeting(&pool, "mine", "Generated", TitleSource::Summary).await.unwrap());
        assert_eq!(title(&pool, "mine").await, ("Budget sync".to_string(), true));

        // A manual rename makes the automatic one the user's; a summary rerun keeps it.
        assert!(rename_meeting(&pool, "auto", "My name for it", TitleSource::User).await.unwrap());
        assert!(!rename_meeting(&pool, "auto", "Rerun title", TitleSource::Summary).await.unwrap());
        assert_eq!(title(&pool, "auto").await, ("My name for it".to_string(), true));
        assert!(!dir.path().join("metadata.json").exists(), "no metadata.json is made for a folder without one");
        assert!(!rename_meeting(&pool, "missing", "Anything", TitleSource::User).await.unwrap());
    }
}
