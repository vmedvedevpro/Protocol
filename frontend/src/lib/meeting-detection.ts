/**
 * Meeting detection is turned off until it stops repeating its prompt (#102).
 * While this is false, Settings hides its section and Labs hides Meeting
 * automation, which acts on detection's events. `AVAILABLE` in
 * `src-tauri/src/meeting_detection.rs` keeps the monitor from starting;
 * turning detection back on means flipping both.
 */
export const MEETING_DETECTION_AVAILABLE = false;
