/**
 * The recordings folder (src-tauri/src/audio/recording_preferences.rs). The
 * folder itself is `save_folder` in the recording preferences
 * (src/api/devices.ts); these are the commands only Settings uses.
 */
import {queryOptions} from '@tanstack/react-query'
import {command} from '@/api/core'

export const recordingsFolderKeys = {
    all: ['recordingsFolder'] as const,
    default: () => [...recordingsFolderKeys.all, 'default'] as const,
}

/** Where recordings go when no folder is saved: Music, Movies or Documents, by platform. */
export const getDefaultRecordingsFolder = () => command<string>('get_default_recordings_folder_path')

export const defaultRecordingsFolderQuery = queryOptions({
    queryKey: recordingsFolderKeys.default(),
    queryFn: getDefaultRecordingsFolder,
    // Fixed for the life of the process.
    staleTime: Infinity,
})

/** The system's folder picker; null when the user cancels. It saves nothing. */
export const pickRecordingsFolder = () => command<string | null>('select_recording_folder')

/** Opens the saved folder in the file manager, creating it first if it is missing. */
export const openRecordingsFolder = () => command<void>('open_recordings_folder')
