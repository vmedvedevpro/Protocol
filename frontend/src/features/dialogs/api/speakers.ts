/** Who said this line's one command no other screen uses (diarization/mod.rs). */
import {command} from '@/api/core'
import type {SpeakerRename} from '@/api/meetings'

/**
 * Gives one line another voice. `from` is the voice replaced on a line
 * where several overlap; the others stay. Text, times and the source of the
 * audio never change.
 */
export const reassignTranscriptSpeaker = (meetingId: string, transcriptId: string, to: string, from: string) =>
    command<SpeakerRename>('reassign_transcript_speaker', {meetingId, transcriptId, to, from})
