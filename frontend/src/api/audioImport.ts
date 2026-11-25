/**
 * Importing an audio or video file as a new meeting
 * (src-tauri/src/audio/import.rs): native code copies it into a meeting
 * folder, transcribes it and saves the meeting, one import at a time, and
 * holds the `import` busy reason while it runs. The types mirror the Rust
 * ones. Import a recording (#119) is the UI; `import-complete` and
 * `import-error` also tell Settings that the after-meeting pass may have
 * changed the speech choice (#117).
 */
import {command} from './core'
import type {NativeEvent} from './events'

/** Mirrors `AudioFileInfo`; `filename` is the name without its extension. */
export interface AudioFileInfo {
    path: string
    filename: string
    duration_seconds: number
    size_bytes: number
    /** The extension in capitals: `M4A`. */
    format: string
}

/**
 * Mirrors `ImportProgress`: `stage` is copying, decoding, resampling, vad,
 * transcribing, saving or complete; the percent climbs from 5 to 100.
 */
export interface ImportProgress {
    stage: string
    progress_percentage: number
    message: string
}

/** The `import-complete` payload. */
export interface ImportResult {
    meeting_id: string
    title: string
    segments_count: number
    duration_seconds: number
}

/** Mirrors `ImportError`; "Import cancelled" after a cancel. */
export interface ImportFailure {
    error: string
}

export const IMPORT_PROGRESS_EVENT = 'import-progress' as NativeEvent<ImportProgress>
export const IMPORT_COMPLETE_EVENT = 'import-complete' as NativeEvent<ImportResult>
export const IMPORT_ERROR_EVENT = 'import-error' as NativeEvent<ImportFailure>

/**
 * What native code imports, lower case; keep in step with
 * `AUDIO_EXTENSIONS` in src-tauri/src/audio/constants.rs.
 */
export const AUDIO_EXTENSIONS = ['mp4', 'm4a', 'wav', 'mp3', 'flac', 'ogg', 'aac', 'mkv', 'webm', 'wma'] as const

/** The formats for a hint: `MP4, M4A, …, WebM, WMA`. */
export const AUDIO_FORMATS_TEXT = AUDIO_EXTENSIONS.map((ext) => (ext === 'webm' ? 'WebM' : ext.toUpperCase())).join(', ')

/** Whether a path's extension is one native code imports. */
export function isAudioPath(path: string): boolean {
    const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase()
    return !!extension && (AUDIO_EXTENSIONS as readonly string[]).includes(extension)
}

/** Opens the system's file picker on the audio formats and checks the file; null when the user cancels. */
export const chooseAudioFile = () => command<AudioFileInfo | null>('select_and_validate_audio_command')

/** Checks a file given by path (a drop): it exists, its format, its length. Rejects with the reason. */
export const checkAudioFile = (path: string) => command<AudioFileInfo>('validate_audio_file_command', {path})

export interface ImportRequest {
    sourcePath: string
    title: string
    /** A language code, or null to detect it; Parakeet always detects. */
    language: string | null
    model: string | null
    provider: 'parakeet' | 'whisper' | null
}

/**
 * Starts the import and returns once native has spawned it; the result
 * arrives as `import-complete` or `import-error`, so listen first. Rejects
 * with "Import already in progress" while another runs.
 */
export const startImport = (request: ImportRequest) =>
    command<{ message: string }>('start_import_audio_command', {...request})

/**
 * Asks native to stop the import; it stops at its next check, removes the
 * meeting folder it made and sends `import-error` "Import cancelled".
 */
export const cancelImport = () => command<null>('cancel_import_command')
