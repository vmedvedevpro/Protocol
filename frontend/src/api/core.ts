import {invoke, type InvokeArgs} from '@tauri-apps/api/core'

export {isTauri} from '@tauri-apps/api/core'

/**
 * A native command that rejected. Rust commands reject with whatever their
 * `Err` serializes to, usually a string, sometimes an enum such as the
 * updater's install refusal; `detail` keeps it for callers that branch on it.
 * Query and error boundaries get an Error with a readable message.
 */
export class CommandError extends Error {
    readonly command: string
    readonly detail: unknown

    constructor(command: string, detail: unknown) {
        super(describe(command, detail))
        this.name = 'CommandError'
        this.command = command
        this.detail = detail
    }
}

function describe(command: string, detail: unknown): string {
    if (typeof detail === 'string') return detail
    if (detail instanceof Error) return detail.message
    return `${command} failed`
}

/** Calls a Tauri command; every wrapper in src/api goes through it. */
export async function command<T>(name: string, args?: InvokeArgs): Promise<T> {
    try {
        return await invoke<T>(name, args)
    } catch (error) {
        throw new CommandError(name, error)
    }
}
