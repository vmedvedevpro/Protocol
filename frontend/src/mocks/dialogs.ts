import type {MockHandler} from './handlers'
import type {MockState} from './state'

/**
 * What the dialogs over a screen (#119) call that no other mock answers:
 * the fs plugin's write for Export. The save dialog is the shell's
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
    }
}

export function dialogsHandlers(state: MockState): Record<string, MockHandler> {
    return {
        // @tauri-apps/plugin-fs writeFile sends the bytes as the whole body.
        'plugin:fs|write_file': (body) => {
            if (state.dialogs.writeError) throw state.dialogs.writeError
            state.dialogs.writtenFiles.push(body as unknown as Uint8Array)
            return null
        },
    }
}
