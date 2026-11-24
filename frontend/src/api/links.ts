import {command} from './core'

/**
 * Opens a link in the default browser (About, credits, driver pages). Native
 * code takes http and https only and rejects anything else
 * (`open_external_url` in src-tauri/src/api/api.rs).
 */
export const openExternalUrl = (url: string) => command<void>('open_external_url', {url})

/**
 * Opens a link from a click, where nothing waits for the result: a failure
 * is logged, and the user can click again.
 */
export function openLink(url: string) {
    openExternalUrl(url).catch((error: unknown) => console.error(`Failed to open ${url}:`, error))
}
