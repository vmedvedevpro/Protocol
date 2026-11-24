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

    // src-tauri/src/updater/commands.rs
    updater_get_status: () => mockState.updater,
}
