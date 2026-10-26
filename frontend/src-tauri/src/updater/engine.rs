//! The calls into tauri-plugin-updater: building the updater, the check, the
//! download, and mapping the plugin's errors to [`ErrorKind`].
//!
//! The check has a 30 s budget. The download has none in total (a slow link
//! may take minutes for ~130 MB) but gives up when the connection cannot be
//! made in 15 s or no data arrives for 60 s. Both go only to the endpoint in
//! `tauri.conf.json` and the asset URLs that feed lists.

use super::status::{ErrorKind, Release};
use super::support::{self, Support};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::{Error as PluginError, Update, Updater, UpdaterExt};
use tokio_util::sync::CancellationToken;

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Progress pushes per second while downloading.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(500);
/// Room needed beside the payload: the cache file, the plugin's temporary
/// copy of the installer, and the install itself.
const SPACE_FACTOR: u64 = 3;

pub type Failure = (ErrorKind, String);

pub fn updater<R: Runtime>(app: &AppHandle<R>, support: Support) -> Result<Updater, Failure> {
    let mut builder = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT));
    if let Some(target) = support::manual_only_feed_target(support) {
        builder = builder.target(target);
    }
    builder.build().map_err(|error| (ErrorKind::Feed, error.to_string()))
}

pub async fn check(updater: &Updater) -> Result<Option<Update>, Failure> {
    updater.check().await.map_err(|error| (classify(&error, ErrorKind::Network), error.to_string()))
}

/// The release an `Update` describes, with the date as the feed wrote it.
pub fn release_of(update: &Update) -> Release {
    Release {
        version: update.version.clone(),
        notes: update.body.clone().filter(|notes| !notes.trim().is_empty()),
        date: update
            .raw_json
            .get("pub_date")
            .and_then(|date| date.as_str())
            .map(str::to_string),
    }
}

pub enum DownloadEnd {
    Done(Vec<u8>),
    Cancelled,
    Failed(Failure),
}

/// Downloads and verifies the payload. `on_progress(received, total)` runs at
/// most twice a second; `free_space` is consulted once the size is known.
pub async fn download(
    update: &Update,
    cancel: CancellationToken,
    free_space: Option<u64>,
    mut on_progress: impl FnMut(u64, Option<u64>),
) -> DownloadEnd {
    let mut received: u64 = 0;
    let mut last_push = Instant::now() - PROGRESS_INTERVAL;
    let mut space_checked = false;
    let space_cancel = cancel.clone();
    let mut too_large: Option<u64> = None;

    let result = {
        let download = update.download(
            |chunk, total| {
                received += chunk as u64;
                if !space_checked {
                    space_checked = true;
                    if let (Some(total), Some(free)) = (total, free_space) {
                        if free < total.saturating_mul(SPACE_FACTOR) {
                            too_large = Some(total.saturating_mul(SPACE_FACTOR));
                            space_cancel.cancel();
                        }
                    }
                }
                if last_push.elapsed() >= PROGRESS_INTERVAL {
                    last_push = Instant::now();
                    on_progress(received, total);
                }
            },
            || {},
        );
        tokio::select! {
            biased;
            _ = cancel.cancelled() => None,
            result = download => Some(result),
        }
    };

    if let Some(needed) = too_large {
        return DownloadEnd::Failed((ErrorKind::DiskSpace, format!("{needed} bytes needed")));
    }
    match result {
        None => DownloadEnd::Cancelled,
        Some(Ok(bytes)) => DownloadEnd::Done(bytes),
        Some(Err(error)) => DownloadEnd::Failed((classify(&error, ErrorKind::Download), error.to_string())),
    }
}

/// Maps a plugin error to the class the UI explains. `io` is the class of an
/// I/O or HTTP failure in the current step (network for a check, download
/// for a download).
pub fn classify(error: &PluginError, io: ErrorKind) -> ErrorKind {
    match error {
        PluginError::ReleaseNotFound => ErrorKind::NoRelease,
        PluginError::TargetNotFound(_) | PluginError::TargetsNotFound(_) => ErrorKind::NoPlatform,
        PluginError::Serialization(_) | PluginError::Semver(_) | PluginError::UrlParse(_) => ErrorKind::Feed,
        PluginError::Reqwest(inner) if inner.is_decode() => ErrorKind::Feed,
        PluginError::Minisign(_)
        | PluginError::Base64(_)
        | PluginError::SignatureUtf8(_)
        | PluginError::SignedVersionMismatch { .. }
        | PluginError::MissingSignedVersion => ErrorKind::Signature,
        PluginError::InvalidUpdaterFormat | PluginError::BinaryNotFoundInArchive => ErrorKind::Signature,
        PluginError::TempDirNotOnSameMountPoint => ErrorKind::Location,
        _ => io,
    }
}

/// Free bytes on the volume holding `path`, when the system reports it.
pub fn free_space(path: &std::path::Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().as_os_str().len())
        .map(|disk| disk.available_space())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_errors_map_to_ui_classes() {
        let cases = [
            (PluginError::ReleaseNotFound, ErrorKind::NoRelease),
            (PluginError::TargetsNotFound(vec!["windows-x86_64".into()]), ErrorKind::NoPlatform),
            (PluginError::MissingSignedVersion, ErrorKind::Signature),
            (
                PluginError::SignedVersionMismatch { signed: "0.3.0".into(), announced: "0.3.1".into() },
                ErrorKind::Signature,
            ),
            (PluginError::Network("Download request failed with status: 404".into()), ErrorKind::Download),
            (PluginError::Io(std::io::Error::other("disk")), ErrorKind::Download),
        ];
        for (error, expected) in cases {
            assert_eq!(classify(&error, ErrorKind::Download), expected, "{error}");
        }
        let feed: PluginError = serde_json::from_str::<serde_json::Value>("{").unwrap_err().into();
        assert_eq!(classify(&feed, ErrorKind::Network), ErrorKind::Feed);
    }

    /// The feed as #15's `scripts/release/make-latest-json.mjs` writes it.
    #[test]
    fn the_release_feed_resolves_every_platform_key() {
        let base = "https://github.com/vmedvedevpro/Protocol/releases/download/v0.3.1";
        let entry = |asset: &str| serde_json::json!({ "signature": format!("sig-{asset}"), "url": format!("{base}/{asset}") });
        let feed = serde_json::json!({
            "version": "0.3.1",
            "notes": "## Protocol 0.3.1\n\n- Fixes",
            "pub_date": "2026-11-02T10:00:00Z",
            "platforms": {
                "windows-x86_64-nsis": entry("protocol-windows-x64-setup.exe"),
                "windows-x86_64": entry("protocol-windows-x64-setup.exe"),
                "darwin-aarch64-app": entry("protocol-macos-arm64.app.tar.gz"),
                "darwin-aarch64": entry("protocol-macos-arm64.app.tar.gz"),
                "linux-x86_64-appimage": entry("protocol-linux-x86_64.AppImage"),
            }
        });
        let release: tauri_plugin_updater::RemoteRelease = serde_json::from_value(feed).unwrap();
        assert_eq!(release.version.to_string(), "0.3.1");
        for (target, asset) in [
            ("windows-x86_64-nsis", "protocol-windows-x64-setup.exe"),
            ("windows-x86_64", "protocol-windows-x64-setup.exe"),
            ("darwin-aarch64-app", "protocol-macos-arm64.app.tar.gz"),
            ("linux-x86_64-appimage", "protocol-linux-x86_64.AppImage"),
        ] {
            assert_eq!(release.download_url(target).unwrap().as_str(), format!("{base}/{asset}"));
            assert_eq!(release.signature(target).unwrap(), &format!("sig-{asset}"));
        }
        // A .deb install has no entry of its own and reads the AppImage's.
        assert!(release.download_url("linux-x86_64-deb").is_err());
        assert!(release.download_url("linux-x86_64").is_err());
    }
}
