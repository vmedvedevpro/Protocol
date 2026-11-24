/**
 * "Summarize so far": a summary of the live transcript while the recording
 * runs (live_assistant.rs), from the summary model Settings chose. Native
 * holds the summary busy reason while it answers, since an answer can
 * outlive Stop.
 */
import {command} from '@/api/core'

const SUMMARIZE_QUESTION =
    'Summarize the meeting so far: the main points, decisions and action items with owners. Keep it short.'

/** Asks for a summary of `transcript` (one line per turn); resolves to Markdown. */
export const summarizeSoFar = (transcript: string, notes: string | null) =>
    command<string>('ask_live_assistant', {
        question: SUMMARIZE_QUESTION,
        transcriptContext: transcript,
        // The user's notes steer what the summary focuses on, as the screen says.
        persona: notes?.trim() ? `The user's own notes from the meeting, to focus on:\n${notes.trim()}` : null,
    })
