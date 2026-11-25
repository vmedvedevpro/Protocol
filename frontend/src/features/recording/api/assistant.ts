/**
 * "Summarize so far": a summary of the live transcript while the recording
 * runs (live_assistant.rs), from the summary model Settings chose. Native
 * holds the summary busy reason while it answers, since an answer can
 * outlive Stop.
 */
import {command} from '@/api/core'
import {type LiveLine, transcriptText} from './transcript'

const SUMMARIZE_QUESTION =
    'Summarize the meeting so far: the main points, decisions and action items with owners. Keep it short.'

// The old UI's budgets for the same command (`162e8be`: lib/live-context.ts,
// LivePanel.tsx). Native sends the context in one request without chunking
// ("may be truncated by the caller"), so a two-hour call would overflow the
// built-in model's 32k-token window.
export const LIVE_TRANSCRIPT_BUDGET = 12_000
export const LIVE_NOTES_BUDGET = 3_000

/** Asks for a summary of the newest lines that fit, steered by the notes; resolves to Markdown. */
export function summarizeSoFar(lines: readonly LiveLine[], notes: string | null) {
    const focus = notes?.trim().slice(0, LIVE_NOTES_BUDGET)
    return command<string>('ask_live_assistant', {
        question: SUMMARIZE_QUESTION,
        transcriptContext: transcriptText(lines, LIVE_TRANSCRIPT_BUDGET),
        // The user's notes steer what the summary focuses on, as the screen says.
        persona: focus ? `The user's own notes from the meeting, to focus on:\n${focus}` : null,
    })
}
