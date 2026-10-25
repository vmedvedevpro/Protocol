use crate::notifications::types::{Notification, NotificationPriority, NotificationTimeout};
use anyhow::{Result, anyhow};
use log::{info as log_info, error as log_error};
use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;
use std::time::Duration;

/// Cross-platform system notification handler
pub struct SystemNotificationHandler<R: Runtime> {
    app_handle: AppHandle<R>,
}

impl<R: Runtime> SystemNotificationHandler<R> {
    pub fn new(app_handle: AppHandle<R>) -> Self {
        Self {
            app_handle,
        }
    }

    /// Show a notification using Tauri's notification plugin
    pub async fn show_notification(&self, notification: Notification) -> Result<()> {
        log_info!("Attempting to show notification: {}", notification.title);

        // Check if DND is active and respect user settings
        if self.is_dnd_active().await && self.should_respect_dnd(&notification) {
            log_info!("DND is active, skipping notification: {}", notification.title);
            return Ok(());
        }

        // Windows: raise a native toast that is attributed to Protocol (with our
        // name + icon) rather than PowerShell. The Tauri plugin can't do this
        // for a portable exe running from `target\release` (see native_windows).
        // Best-effort: on any failure we fall through to the plugin below so we
        // never end up showing no toast at all.
        #[cfg(windows)]
        {
            match crate::notifications::native_windows::show_toast(
                &self.app_handle,
                &notification.title,
                &notification.body,
            ) {
                Ok(_) => {
                    log_info!("Showed native Windows toast: {}", notification.title);
                    return Ok(());
                }
                Err(e) => {
                    log_error!("Native Windows toast failed ({e}); falling back to Tauri plugin");
                }
            }
        }

        // Use Tauri notification for all platforms
        log_info!("Showing Tauri notification: {}", notification.title);

        let builder = self.app_handle.notification().builder()
            .title(&notification.title)
            .body(&notification.body);

        match builder.show() {
            Ok(_) => {
                log_info!("Successfully showed Tauri notification: {}", notification.title);
                Ok(())
            }
            Err(e) => {
                log_error!("Failed to show Tauri notification: {}", e);
                Err(anyhow!("Failed to show notification: {}", e))
            }
        }
    }

    /// Check if Do Not Disturb is currently active
    /// Note: DND is managed through app settings, not system-level checks
    pub async fn is_dnd_active(&self) -> bool {
        // App manages DND through its own notification settings
        // No need to check system-level DND status
        false
    }

    /// Request notification permission from the system
    pub async fn request_permission(&self) -> Result<bool> {
        log_info!("Requesting notification permission");

        // On most platforms with Tauri, permissions are handled automatically
        // We don't need to show a test notification during initialization
        log_info!("Notification permission granted (automatic for Tauri apps)");
        Ok(true)
    }

    /// Determine if we should respect DND for this notification
    fn should_respect_dnd(&self, notification: &Notification) -> bool {
        match notification.priority {
            NotificationPriority::Critical => false, // Always show critical notifications
            _ => true, // Respect DND for all other priorities
        }
    }
}

/// Convert notification timeout to duration
impl From<&NotificationTimeout> for Option<Duration> {
    fn from(timeout: &NotificationTimeout) -> Self {
        match timeout {
            NotificationTimeout::Never => None,
            NotificationTimeout::Seconds(secs) => Some(Duration::from_secs(*secs)),
            NotificationTimeout::Default => Some(Duration::from_secs(5)),
        }
    }
}