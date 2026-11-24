/**
 * The summary language a meeting gets when the recording saves it (PARITY.md,
 * Stop and save order): the pinned default when the user pinned one, else
 * the transcript's detected language, kept so it is not detected again.
 * A failure leaves it to Auto when the summary is written.
 */
import {resolveSummaryLanguage, saveMeetingSummaryLanguage} from '@/api/meetings'
import {useSummaryLanguageStore} from '@/api/preferences'

export async function applySummaryLanguage(meetingId: string, texts: string[]) {
    const pinned = useSummaryLanguageStore.getState().value
    if (pinned) {
        await saveMeetingSummaryLanguage(meetingId, pinned).catch(() => undefined)
        return
    }
    await resolveSummaryLanguage(meetingId, texts).catch(() => undefined)
}
