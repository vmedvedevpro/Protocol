/**
 * What the tray (src-tauri/src/tray.rs) asks of the main window. Both go to
 * the main window only (`emit_to("main", …)`), and both are handled without a
 * reload: a reload would drop a meeting still being saved and the queued
 * post-call jobs.
 */
import type {NativeEvent} from './events'

/**
 * A path to open with the router: `/settings` (Settings) and
 * `/settings?section=about` (Check for Updates…, Update Available, a refused
 * Restart to Update). The router must keep resolving both.
 */
export const TRAY_NAVIGATE_EVENT = 'tray-navigate' as NativeEvent<string>

/**
 * Start Recording in the tray. Native code sends it only while nothing is
 * recording (it stops a running recording itself) and keeps the menu on
 * Start until the recording has started, so a second click sends it again.
 * The old UI's name, kept, although it only ever asks for a start.
 */
export const TRAY_START_RECORDING_EVENT = 'request-recording-toggle' as NativeEvent<null>
