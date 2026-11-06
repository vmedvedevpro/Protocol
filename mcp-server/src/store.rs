//! Read-only access to the app's database.
//!
//! The app's database uses SQLite's rollback journal, not WAL: sqlx 0.8 sets no
//! `journal_mode` and neither does the app. While a statement of this server
//! runs it holds a SHARED lock, and an app commit (the transcript save on Stop)
//! waits for it, giving up after its pool's 5 s `busy_timeout`. Locks are held
//! only while a statement steps, so every statement here is cut off by
//! [`STATEMENT_TIME`] through a progress handler and answered with "narrow the
//! question", and no transaction stays open between tool calls.

use sqlx::migrate::Migrator;
use sqlx::pool::PoolConnection;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Sqlite, SqlitePool};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The app's migrations, embedded for their versions only: a database whose
/// newest applied version is older than this list has not been migrated by
/// the Protocol this server shipped with. Nothing here ever runs them.
pub static APP_MIGRATIONS: Migrator = sqlx::migrate!("../frontend/src-tauri/migrations");

/// Longest a tool call may spend in SQLite statements before it is stopped.
/// An app commit waits at most this long for this server's lock, well inside
/// the app's 5 s busy timeout.
pub const STATEMENT_TIME: Duration = Duration::from_secs(1);
/// How long a statement waits for the app's own write to finish.
const BUSY_TIMEOUT: Duration = Duration::from_secs(3);
/// SQLite virtual-machine steps between deadline checks.
const PROGRESS_STEPS: i32 = 1_000;

/// Why a tool call could not read the library, worded for the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    AccessOff,
    NoDatabase(Vec<PathBuf>),
    Unreadable { path: PathBuf, detail: String },
    NotProtocol(PathBuf),
    OlderDatabase,
    NeedsRecovery,
    TooBroad,
    Busy,
    NotFound(String),
    BadArgument(String),
    Failed(String),
}

impl Problem {
    pub fn message(&self) -> String {
        match self {
            Problem::AccessOff => "Protocol's access for AI agents is off. The user can turn it on in \
                Protocol > Settings > AI agents (\"Let AI agents read your meetings\"); nothing \
                needs restarting."
                .to_string(),
            Problem::NoDatabase(tried) => format!(
                "Protocol's meeting database was not found. Looked at: {}. If Protocol has never \
                 been opened on this computer, open it once. A database elsewhere can be named \
                 with --db <path> or the PROTOCOL_MCP_DB environment variable.",
                tried
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            Problem::Unreadable { path, detail } => {
                format!("Protocol's database at {} could not be read: {detail}", path.display())
            }
            Problem::NotProtocol(path) => format!(
                "{} is not a database created by Protocol (it has no migration history).",
                path.display()
            ),
            Problem::OlderDatabase => "Protocol was updated but has not opened its database since. Open \
                Protocol once so it can update the database, then ask again."
                .to_string(),
            Problem::NeedsRecovery => "Protocol's database has an unfinished write from an unexpected exit, \
                which only Protocol may roll back. Open Protocol once, then ask again."
                .to_string(),
            Problem::TooBroad => format!(
                "This question took longer than {} s to read and was stopped so Protocol can keep \
                 saving meetings. Narrow it by date (from/to), person or group, or ask for fewer \
                 results.",
                STATEMENT_TIME.as_secs()
            ),
            Problem::Busy => "Protocol is writing to its database right now (for example saving a \
                meeting). Ask again in a few seconds."
                .to_string(),
            Problem::NotFound(message) | Problem::BadArgument(message) => message.clone(),
            Problem::Failed(detail) => format!("Reading Protocol's database failed: {detail}"),
        }
    }
}

impl From<sqlx::Error> for Problem {
    fn from(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(database) = &error {
            let extended: i32 = database
                .code()
                .and_then(|code| code.parse().ok())
                .unwrap_or_default();
            // SQLITE_READONLY_ROLLBACK: a hot journal that a read-only
            // connection may not roll back.
            if extended == 776 {
                return Problem::NeedsRecovery;
            }
            match extended & 0xff {
                9 => return Problem::TooBroad,      // SQLITE_INTERRUPT
                5 | 6 => return Problem::Busy,      // SQLITE_BUSY, SQLITE_LOCKED
                _ => {}
            }
        }
        if matches!(error, sqlx::Error::PoolTimedOut) {
            return Problem::Busy;
        }
        Problem::Failed(error.to_string())
    }
}

/// An open read-only pool on one database file. Clones share the pool.
#[derive(Clone)]
pub struct Library {
    pool: SqlitePool,
    path: PathBuf,
}

/// One tool call's connection. Every statement on it stops once the call has
/// spent [`STATEMENT_TIME`] since the session began.
pub struct Session {
    pub conn: PoolConnection<Sqlite>,
    /// The database has migrations this server does not know: Protocol was
    /// updated after the client started this server.
    pub newer_database: bool,
}

impl Library {
    /// Opens nothing yet: connections are made by the first [`Library::session`].
    pub fn new(path: &Path) -> Self {
        let options = SqliteConnectOptions::new()
            .filename(path)
            // SQLITE_OPEN_READONLY, not `immutable`: changes the app commits
            // stay visible, and SQLite still honours the app's locks.
            .read_only(true)
            .create_if_missing(false)
            .busy_timeout(BUSY_TIMEOUT)
            .pragma("query_only", "ON");
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .min_connections(0)
            // Idle connections close soon, so the file is not held open for
            // the whole life of a client session.
            .idle_timeout(Duration::from_secs(30))
            // A returned connection keeps the last call's expired deadline
            // until the next session replaces it; a ping would trip it.
            .test_before_acquire(false)
            .acquire_timeout(BUSY_TIMEOUT + Duration::from_secs(2))
            // The search lowers text with it; registering writes nothing.
            .after_connect(|conn, _| Box::pin(meeting_library::sql::register(conn)))
            .connect_lazy_with(options);
        Library {
            pool,
            path: path.to_path_buf(),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn session(&self) -> Result<Session, Problem> {
        let mut conn = self.pool.acquire().await.map_err(|error| self.open_error(error))?;
        let deadline = Instant::now() + STATEMENT_TIME;
        conn.lock_handle()
            .await
            .map_err(|error| self.open_error(error))?
            .set_progress_handler(PROGRESS_STEPS, move || Instant::now() < deadline);

        let newest: Option<i64> = match sqlx::query_scalar(
            "SELECT MAX(version) FROM _sqlx_migrations WHERE success = 1",
        )
        .fetch_one(&mut *conn)
        .await
        {
            Ok(version) => version,
            Err(sqlx::Error::Database(error)) if error.message().contains("no such table") => {
                return Err(Problem::NotProtocol(self.path.clone()));
            }
            Err(error) => return Err(self.open_error(error)),
        };
        let Some(newest) = newest else {
            return Err(Problem::NotProtocol(self.path.clone()));
        };
        let known = APP_MIGRATIONS
            .iter()
            .map(|migration| migration.version)
            .max()
            .unwrap_or_default();
        if newest < known {
            return Err(Problem::OlderDatabase);
        }
        Ok(Session {
            conn,
            newer_database: newest > known,
        })
    }

    fn open_error(&self, error: sqlx::Error) -> Problem {
        match Problem::from(error) {
            Problem::Failed(detail) => Problem::Unreadable {
                path: self.path.clone(),
                detail,
            },
            other => other,
        }
    }
}
