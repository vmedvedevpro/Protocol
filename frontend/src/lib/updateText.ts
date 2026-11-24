/**
 * How the app speaks about its updates, in one place: Settings › Updates
 * (#114) and the update banner and toasts (#113) say the same things.
 * Wording from the old UI (`lib/updater.ts` and `components/updater/*` at
 * 162e8be).
 */
import type {BusyReason, UpdateError, UpdaterSnapshot} from '@/api/updater'

export const RELEASES_URL = 'https://github.com/vmedvedevpro/Protocol/releases'

/** A release's page, where its notes and packages are. */
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version}`

export const RESTART_NOTE =
    'Protocol closes for about half a minute while the update installs, then opens again. Your meetings and settings are kept.'
export const MAC_PERMISSIONS_NOTE = 'macOS may ask again for microphone and screen recording access after the update.'
export const MANUAL_NOTE = "Packages installed with apt don't update themselves. Download the new package from GitHub."

const BUSY_SENTENCES: Record<BusyReason, string> = {
    recording: 'a recording is in progress',
    recordingStopping: 'a recording is being saved',
    recordingSave: 'a recording is being saved',
    import: 'an audio import is running',
    retranscription: 'a meeting is being retranscribed',
    diarization: 'speakers are being identified',
    summary: 'a summary is being generated',
    postCall: 'a meeting is being processed',
    modelDownload: 'a model is downloading',
    modelCompile: 'a speech model is being prepared for the GPU',
    onboarding: "setup isn't finished",
    speechEngine: 'the speech engine is busy',
}

/** Why Restart and update has to wait. */
export const busySentence = (reason: BusyReason) => `Protocol can't restart while ${BUSY_SENTENCES[reason]}.`

function platformName(platform: UpdaterSnapshot['platform']): string {
    if (platform === 'macos') return 'macOS'
    return platform === 'windows' ? 'Windows' : 'Linux'
}

/**
 * What went wrong, for the user. `version` is the release being installed
 * and `current` the running one, for a failed install.
 */
export function errorSentence(
    error: UpdateError,
    platform: UpdaterSnapshot['platform'],
    version?: string,
    current?: string,
): string {
    switch (error.kind) {
        case 'network':
            return "Couldn't reach GitHub. Check your connection and try again."
        case 'noRelease':
            return 'No published release found.'
        case 'noPlatform':
            return `A newer version isn't available for ${platformName(platform)} yet.`
        case 'feed':
            return "The update information on GitHub couldn't be read."
        case 'signature':
            return 'The downloaded update failed its signature check and was deleted. Nothing was installed.'
        case 'download':
            return `The download stopped: ${error.message}.`
        case 'diskSpace':
            return 'Not enough free disk space for the update.'
        case 'installStart':
            return `The installer couldn't start (${error.message}). Protocol is still running.`
        case 'installIncomplete':
            return `The update${version ? ` to ${version}` : ''} didn't finish. Protocol is still on ${current ?? 'the previous version'}.`
        case 'location':
            return platform === 'macos'
                ? 'Move Protocol to the Applications folder and try again.'
                : "Protocol can't replace the AppImage because its folder is read-only. Download the new AppImage from GitHub."
    }
}

/** "just now", "5 minutes ago", "yesterday", for a Unix time in milliseconds. */
export function relativeTime(at: number, now = Date.now()): string {
    const seconds = Math.round((now - at) / 1000)
    if (seconds < 60) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    return days === 1 ? 'yesterday' : `${days} days ago`
}
