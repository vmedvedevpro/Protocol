import type {Platform} from '@/lib/platform'
import {audioHandlers} from './audio'
import {devicesHandlers} from './devices'
import {dialogsHandlers} from './dialogs'
import {labsHandlers} from './labs'
import {liveHandlers} from './live'
import {meetingsHandlers} from './meetings'
import {minibarHandlers} from './minibar'
import {modelCatalogHandlers} from './modelCatalog'
import {modelsHandlers} from './models'
import {notesHandlers} from './notes'
import {peopleHandlers} from './people'
import {onboardingHandlers} from './onboarding'
import {macosPermissionsHandlers, permissionsHandlers} from './permissions'
import {postCallHandlers} from './postCall'
import {preferencesHandlers} from './preferences'
import {shellHandlers} from './shell'
import {speechHandlers} from './speech'
import {templatesHandlers} from './templates'
import {updaterHandlers} from './updater'
import {mockState} from './state'

export type MockArgs = Record<string, unknown>
export type MockHandler = (args: MockArgs) => unknown

/**
 * Mock replies by command name: the Rust `#[tauri::command]` name, or
 * `plugin:<plugin>|<command>` for what @tauri-apps/api sends to a plugin. A
 * handler gets the invoke arguments and returns the reply, or a promise of it;
 * throwing rejects the call, as an `Err` from Rust does.
 */
export const handlers: Record<string, MockHandler> = {
    // @tauri-apps/api
    'plugin:app|version': () => mockState.appVersion,
    'plugin:window|set_theme': () => null,

    // src-tauri/src/api/api.rs
    open_external_url: ({url}) => {
        // Tauri rejects before the command runs when the argument is missing.
        if (url === undefined) {
            throw 'invalid args `url` for command `open_external_url`: command open_external_url missing required key url'
        }
        const link = String(url)
        if (!link.startsWith('https://') && !link.startsWith('http://')) {
            throw 'Only HTTP and HTTPS links can be opened'
        }
        mockState.openedUrls.push(link)
        return null
    },

    // src-tauri/src/updater/commands.rs
    ...updaterHandlers(mockState),

    // src-tauri/src/model_catalog/commands.rs
    ...modelCatalogHandlers(mockState),

    ...audioHandlers,

    // The window shell: window calls, the save dialog, onboarding.rs, crash_report.rs
    ...shellHandlers,

    // src-tauri/src/database/repositories/meeting_notes.rs
    ...notesHandlers(mockState),

    // get_audio_devices (lib.rs), src-tauri/src/audio/recording_preferences.rs
    ...devicesHandlers(mockState),

    // set_language_preference (lib.rs), api_get_model_config (api/api.rs)
    ...preferencesHandlers(mockState),

    // Parakeet, Whisper and the built-in summary models
    ...modelsHandlers(mockState),

    // Microphone and computer-audio permissions
    ...permissionsHandlers,

    // src-tauri/src/audio/retranscription.rs, diarization/mod.rs
    ...postCallHandlers(mockState),

    // Meetings, transcripts, folders, summaries, action items, speaker labels (src/mocks/meetings.ts)
    ...meetingsHandlers(mockState),

    // Contacts and their voices (src/mocks/people.ts); after the meetings, whose action item list it wraps
    ...peopleHandlers(mockState),

    // First launch and its database: onboarding.rs, database/commands.rs
    ...onboardingHandlers(mockState),

    // The recorder, its live transcript and the save hand-over (src/mocks/live.ts)
    ...liveHandlers(mockState),

    // The transcript config and the vocabulary (src/mocks/speech.ts)
    ...speechHandlers(mockState),

    // The native Labs switches (src/mocks/labs.ts)
    ...labsHandlers(mockState),

    // Summary templates and the stored default: summary/template_commands.rs, template_settings.rs
    ...templatesHandlers(mockState),

    // The minibar window and its Stop (src/mocks/minibar.ts)
    ...minibarHandlers(mockState),
    // What the dialogs over a screen write and import (src/mocks/dialogs.ts)
    ...dialogsHandlers(mockState),
}

/**
 * Commands native code registers on one platform only (`#[cfg]` in
 * `generate_handler!`; "Windows only" and "macOS only" in PARITY.md). The mock
 * answers one only when `mockState.platform` matches: src/lib/platform.ts sets
 * it (`?platform=` in the browser), and a test or story can change it.
 * Elsewhere it rejects as Tauri does for a command that does not exist, which
 * screens show as "not available". A command is in one of the two maps, never
 * both; ipc.ts refuses to load otherwise.
 */
export const platformHandlers: Record<Platform, Record<string, MockHandler>> = {
    windows: {},
    macos: {
        ...macosPermissionsHandlers,
    },
    linux: {},
}
