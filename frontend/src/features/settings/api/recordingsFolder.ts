/**
 * The recordings folder (src-tauri/src/audio/recording_preferences.rs). The
 * folder itself is `save_folder` in the recording preferences
 * (src/api/devices.ts); these are the commands only Settings uses.
 */
import {command} from '@/api/core'

/** The system's folder picker; null when the user cancels. It saves nothing. */
export const pickRecordingsFolder = () => command<string | null>('select_recording_folder')

/** Opens the saved folder in the file manager, creating it first if it is missing. */
export const openRecordingsFolder = () => command<void>('open_recordings_folder')
