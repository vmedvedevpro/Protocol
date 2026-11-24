/**
 * Keeps a meeting's action item rows in step with its AI summary. When a
 * summary contains an action section, its items become rows (native links
 * owners to contacts) and the section leaves the summary, so the meeting
 * shows each item once; the untrimmed text stays on the summary as
 * `original_markdown`. A summary without a recognisable action section is
 * never changed. Ported from the old UI
 * (`162e8be:frontend/src/lib/action-item-sync.ts`).
 */
import {
    type ActionItem,
    getUnsyncedActionMeetings,
    saveSummaryBySystem,
    syncSummaryActionItems,
} from '@/api/actionItems'
import {getAllTranscripts, getSummary, type TranscriptSegment} from '@/api/meetings'
import {extractActionItems, fingerprint, locateInTranscript} from './actionItemText'
import {completeSummaryMarkdown, parseSummaryData} from './summaryMarkdown'

export interface SyncOutcome {
    changed: boolean
    items?: ActionItem[]
}

const timedLines = (lines: TranscriptSegment[]) =>
    lines.map((line) => ({id: line.id, text: line.text, timestamp: line.audio_start_time ?? 0}))

/**
 * Moves the action section of `summaryData` into the meeting's rows. Each
 * item links to the moment it was said when a transcript line matches it
 * well enough (`locateInTranscript`).
 */
export async function syncMeetingActionItems(
    meetingId: string,
    summaryData: unknown,
    transcript?: TranscriptSegment[],
): Promise<SyncOutcome> {
    const data = parseSummaryData(summaryData)
    const markdown = completeSummaryMarkdown(data)
    if (!markdown.trim()) return {changed: false}
    const result = extractActionItems(markdown)
    if (!result.hadActionSection) return {changed: false}
    const lines = transcript ? timedLines(transcript) : []
    const drafts = result.drafts.map((draft) => {
        const located = lines.length ? locateInTranscript(draft.text, lines) : null
        return {...draft, audioTime: located?.audioTime ?? null, transcriptId: located?.transcriptId ?? null}
    })
    const items = await syncSummaryActionItems(meetingId, drafts, fingerprint(result.remainingMarkdown))
    await saveSummaryBySystem(meetingId, {
        markdown: result.remainingMarkdown,
        original_markdown: typeof data?.original_markdown === 'string' ? data.original_markdown : markdown,
    })
    return {changed: true, items}
}

// Not needed after the update (PARITY.md, sessionStorage): the backfill runs
// once per session, as the old UI's did.
const BACKFILL_KEY = 'af-action-backfill-done'
const BACKFILL_LIMIT = 400
// Spaces the meetings out, so a library of hundreds does not hold the
// database for one long burst at startup.
const BACKFILL_PAUSE_MS = 40

/**
 * Reads action items out of meetings summarized before items were rows.
 * Native lists the meetings whose summary was never read; a summary without
 * an action section is recorded as read with no items. Answers how many
 * meetings changed.
 */
export async function backfillActionItems(): Promise<number> {
    try {
        if (sessionStorage.getItem(BACKFILL_KEY)) return 0
        sessionStorage.setItem(BACKFILL_KEY, '1')
    } catch {
        // Without session storage the backfill may run again next launch.
    }
    const ids = await getUnsyncedActionMeetings().catch(() => [] as string[])
    let changed = 0
    for (const meetingId of ids.slice(0, BACKFILL_LIMIT)) {
        try {
            const summary = await getSummary(meetingId)
            const markdown = completeSummaryMarkdown(parseSummaryData(summary.data))
            if (extractActionItems(markdown).hadActionSection) {
                const outcome = await syncMeetingActionItems(meetingId, summary.data, await getAllTranscripts(meetingId).catch(() => []))
                if (outcome.changed) changed += 1
            } else {
                await syncSummaryActionItems(meetingId, [], fingerprint(markdown))
            }
        } catch {
            // One meeting that cannot be read does not stop the others.
        }
        await new Promise((resolve) => setTimeout(resolve, BACKFILL_PAUSE_MS))
    }
    return changed
}

/** Whether a summary still holds an action section to move into rows. */
export function hasActionSection(summaryData: unknown): boolean {
    const markdown = completeSummaryMarkdown(parseSummaryData(summaryData))
    return !!markdown.trim() && extractActionItems(markdown).hadActionSection
}

const inFlight = new Map<string, Promise<SyncOutcome>>()

/**
 * Moves a finished summary's action section into rows, once: the meeting
 * screen calls it when it sees one, whether the run ended there or while
 * the user was elsewhere. It reads the summary from native again rather
 * than trusting the caller's copy, so a second call after the rewrite finds
 * no section and changes nothing. A summary the user edited is left alone:
 * a heading they typed is theirs.
 */
export function syncFinishedSummary(meetingId: string): Promise<SyncOutcome> {
    const running = inFlight.get(meetingId)
    if (running) return running
    const sync = (async (): Promise<SyncOutcome> => {
        const summary = await getSummary(meetingId)
        if (summary.status !== 'completed' || summary.userEdited || !hasActionSection(summary.data)) return {changed: false}
        return syncMeetingActionItems(meetingId, summary.data, await getAllTranscripts(meetingId).catch(() => []))
    })().finally(() => inFlight.delete(meetingId))
    inFlight.set(meetingId, sync)
    return sync
}
