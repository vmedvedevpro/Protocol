//! The Windows shell identity of the running process.
//!
//! Protocol is an unpackaged app, so Windows gives its process an
//! AppUserModelID (AUMID) derived from the executable path. The installer
//! stamps the Start menu and desktop shortcuts with the bundle identifier as
//! their AUMID instead (`SetLnkAppUserModelId` in `windows/installer.nsi`).
//! The taskbar groups a window with a pinned shortcut only when their AUMIDs
//! match, so `bind_process` gives this process the shortcuts' AUMID.
//!
//! Windows requires the call before the process shows any UI or touches its
//! Jump List, so `lib.rs` makes it first thing in `run()`, before Tauri
//! creates a window.

use windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;

/// Tauri's bundle identifier (`tauri.conf.json`), which the installer writes
/// to its shortcuts as their AUMID.
const APP_USER_MODEL_ID: &str = "io.github.vmedvedevpro.protocol";

/// Bind this process to the installer shortcuts' AUMID. Best-effort: on
/// failure the app runs as before, only with its own taskbar button.
pub fn bind_process() {
    // UTF-16, null-terminated, as the wide-string Win32 APIs expect.
    let id: Vec<u16> = APP_USER_MODEL_ID
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(id.as_ptr()) };
    if hr != 0 {
        log::warn!("SetCurrentProcessExplicitAppUserModelID failed: 0x{hr:08X}");
    } else {
        log::info!("Bound the process to AUMID '{APP_USER_MODEL_ID}'");
    }
}
