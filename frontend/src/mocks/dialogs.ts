import {emit} from '@tauri-apps/api/event'
import {
    AUDIO_EXTENSIONS,
    type AudioFileInfo,
    IMPORT_COMPLETE_EVENT,
    IMPORT_ERROR_EVENT,
    IMPORT_PROGRESS_EVENT,
    type ImportRequest,
    isAudioPath,
} from '@/api/audioImport'
import type {NativeEvent} from '@/api/events'
import type {MockArgs, MockHandler} from './handlers'
import {sampleTranscript} from './meetings'
import type {MockState} from './state'

/**
 * What the dialogs over a screen (#119) call that no other mock answers:
 * the fs plugin's write for Export, and the import of a recording
 * (src-tauri/src/audio/import.rs). The save dialog is the shell's
 * (`plugin:dialog|save`, src/mocks/shell.ts).
 */
export function createMockDialogs() {
    return {
        /**
         * Every file Export wrote, newest last. The plugin sends the path in a
         * header, which the mock IPC does not pass on, so only the bytes are kept.
         */
        writtenFiles: [] as Uint8Array[],
        /** A write fails with this, as a full disk or a refused path would. */
        writeError: null as string | null,
        /** What the file picker answers; null is Cancel. */
        pickedFile: mockAudioFile('/home/user/Recordings/client-call-nov-21.m4a') as AudioFileInfo | null,
        /** The imports started, in order. */
        imports: [] as ImportRequest[],
        /** The import running; native runs one at a time. */
        importing: false,
        cancelled: false,
        /** An import ends with this error instead of a meeting. */
        importError: null as string | null,
        /** One step of the fake import, ms; a test sets 0. */
        importStepMs: 400,
    }
}

/** The file native's check would describe: 38 minutes of it. */
export function mockAudioFile(path: string, seconds = 2_280): AudioFileInfo {
    const name = path.split(/[\\/]/).pop() ?? path
    const dot = name.lastIndexOf('.')
    return {
        path,
        filename: dot > 0 ? name.slice(0, dot) : name,
        duration_seconds: seconds,
        size_bytes: 36_480_000,
        format: dot > 0 ? name.slice(dot + 1).toUpperCase() : '',
    }
}

// Native's stages and percents (import.rs `emit_progress`), shortened.
const IMPORT_READINGS: readonly [stage: string, percent: number, message: string][] = [
    ['copying', 10, 'Copying audio file...'],
    ['decoding', 15, 'Decoding audio file...'],
    ['vad', 25, 'Detecting speech segments...'],
    ['transcribing', 30, 'Loading transcription engine...'],
    ['transcribing', 55, 'Transcribing segment 4 of 8...'],
    ['transcribing', 80, 'Transcribing segment 8 of 8...'],
    ['saving', 90, 'Writing transcript files...'],
    ['complete', 100, 'Import complete'],
]

function send<T>(event: NativeEvent<T>, payload: T) {
    // After clearMocks() at the end of a test there is no IPC to send to.
    emit(event, payload).catch(() => undefined)
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function dialogsHandlers(state: MockState): Record<string, MockHandler> {
    async function run(request: ImportRequest) {
        const own = state.dialogs
        const end = () => {
            own.importing = false
        }
        for (const [stage, percent, message] of IMPORT_READINGS) {
            await wait(own.importStepMs)
            // A reset between tests or stories gives `state.dialogs` a new object.
            if (state.dialogs !== own) return
            if (own.cancelled) {
                end()
                send(IMPORT_ERROR_EVENT, {error: 'Import cancelled'})
                return
            }
            if (own.importError && percent >= 30) {
                end()
                send(IMPORT_ERROR_EVENT, {error: own.importError})
                return
            }
            send(IMPORT_PROGRESS_EVENT, {stage, progress_percentage: percent, message})
        }
        const id = `meeting-import-${state.dialogs.imports.length}`
        state.meetings.meetings.push({id, title: request.title, created_at: new Date().toISOString(), group_id: null, folder_path: `/preview/${id}`})
        state.meetings.transcripts[id] = sampleTranscript('meeting-acme-review')
        end()
        send(IMPORT_COMPLETE_EVENT, {meeting_id: id, title: request.title, segments_count: state.meetings.transcripts[id].length, duration_seconds: 2_280})
    }

    return {
        // @tauri-apps/plugin-fs writeFile sends the bytes as the whole body.
        'plugin:fs|write_file': (body) => {
            if (state.dialogs.writeError) throw state.dialogs.writeError
            state.dialogs.writtenFiles.push(body as unknown as Uint8Array)
            return null
        },
        // api/api.rs: a meeting's own words (Enhance transcript clears them).
        api_save_meeting_vocabulary: ({meetingId, vocabulary}: MockArgs) => {
            const list = String(vocabulary ?? '').split(/[,\n\r]/).map((term) => term.trim()).filter(Boolean).join('\n')
            state.speech.vocabulary.meetings[String(meetingId)] = list
            return list
        },
        // diarization/mod.rs: one line gets another voice; the other voices of an overlap stay.
        reassign_transcript_speaker: ({meetingId, transcriptId, to, from}: MockArgs) => {
            const line = state.meetings.transcripts[String(meetingId)]?.find((entry) => entry.id === transcriptId)
            if (!line) throw `Transcript line not found: ${String(transcriptId)}`
            const parts = (line.speaker ?? '').split(' + ')
            line.speaker = [...new Set(parts.map((part) => (part === from ? String(to) : part)))].join(' + ')
            return {speaker: line.speaker, count: 1, removedName: false}
        },
        select_and_validate_audio_command: () => state.dialogs.pickedFile,
        validate_audio_file_command: ({path}: MockArgs) => {
            const file = String(path)
            if (!isAudioPath(file)) throw `Unsupported format: .${file.split('.').pop()}. Supported: ${AUDIO_EXTENSIONS.join(', ')}`
            return mockAudioFile(file)
        },
        start_import_audio_command: (args: MockArgs) => {
            if (state.dialogs.importing) throw 'Import already in progress'
            const request = args as unknown as ImportRequest
            state.dialogs.imports.push(request)
            Object.assign(state.dialogs, {importing: true, cancelled: false})
            void run(request)
            return {message: 'Import started'}
        },
        cancel_import_command: () => {
            if (!state.dialogs.importing) throw 'No import in progress'
            state.dialogs.cancelled = true
            return null
        },
    }
}
