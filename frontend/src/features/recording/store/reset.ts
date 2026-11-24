import {queryClient} from '@/lib/queryClient'
import {closeRecovery} from '../api/recovery'
import {registerLinks} from './links'
import {clearLiveNotes} from './liveNotes'
import {resetPostCallRunner} from './postCallRunner'
import {registerQueryClient} from './queries'
import {resetRecoveryOffer} from './recover'
import {session} from './session'

/**
 * Forgets everything the recording keeps in modules: the session, its
 * notes, the post-call passes, the recovery offer and connection, and what
 * the runtime registered. Tests run it between cases (src/test/setup.ts).
 */
export async function resetRecording() {
    clearLiveNotes()
    session.reset()
    resetPostCallRunner()
    resetRecoveryOffer()
    registerLinks({openRecording: () => {}, openMeeting: () => {}, openSpeechModels: () => {}})
    registerQueryClient(queryClient)
    queryClient.clear()
    await closeRecovery()
}
