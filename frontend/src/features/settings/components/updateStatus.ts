/**
 * What the update rows of Settings › General say, by state, as StatusLine
 * statuses; `now` dates the last check.
 */
import type {CatalogStatus} from '@/api/modelCatalog'
import {downloadPercent, type UpdaterSnapshot} from '@/api/updater'
import type {Status} from '@/components/ui/StatusLine'
import {errorSentence, relativeTime} from '@/lib/updateText'

/** What the app update row says, by state; `now` dates the last check. */
export function appUpdateStatus(snapshot: UpdaterSnapshot, now: number): Status {
    const {support, activity, offer, error, lastCheckedAt} = snapshot
    if (support.kind === 'off') {
        return support.reason === 'dev'
            ? {key: 'off', text: 'Updates are off in development builds'}
            : {key: 'off', text: 'Updates are off: this copy wasn’t installed by the Protocol installer'}
    }
    if (activity.state === 'checking') return {key: 'checking', text: 'Checking for updates…', busy: true}
    if (activity.state === 'installing') return {key: 'installing', text: 'Starting the update…', busy: true}
    if (offer) {
        const version = offer.release.version
        if (activity.state === 'downloading') {
            const percent = downloadPercent(activity)
            return {key: 'downloading', text: `Downloading ${version}`, value: percent === null ? undefined : `${percent}%`}
        }
        if (offer.manualOnly) return {key: 'manual', text: `${version} is available`}
        if (offer.downloaded) return {key: 'ready', text: `${version} is ready to install`}
        if (offer.waitingForRecording) return {key: 'waiting', text: `${version} downloads after the recording`}
        return {key: 'available', text: `${version} is available`}
    }
    if (error && !error.background && error.action === 'check') {
        return {key: 'check-failed', text: errorSentence(error, snapshot.platform)}
    }
    if (lastCheckedAt !== null) return {key: 'up-to-date', text: 'Up to date, checked', value: relativeTime(lastCheckedAt, now)}
    return {key: 'not-checked', text: 'Not checked yet'}
}

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What the model updates row says. Per-model updates are offered on the models' own pages (#117). */
export function catalogStatus(status: CatalogStatus, now: number): Status {
    if (status.checking) return {key: 'checking', text: 'Checking for model updates…', busy: true}
    if (status.error) return {key: 'failed', text: 'The last check failed'}
    if (status.lastCheckedAt === null) return {key: 'not-checked', text: 'Speech and summary model files, not checked yet'}
    if (status.updates.length > 0) return {key: 'updates', text: `${plural(status.updates.length, 'model update')} available`}
    if (status.checkFailures.length > 0) {
        return {key: 'unchecked', text: `${plural(status.checkFailures.length, 'model')} couldn’t be checked`}
    }
    return {key: 'up-to-date', text: 'Up to date, checked', value: relativeTime(status.lastCheckedAt, now)}
}
