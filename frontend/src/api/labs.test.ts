import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {DEFAULT_LABS, LABS_KEY, nativeLabQuery, readLabs, setLab, setNativeLabMutation, useLabsStore, type NativeLab} from './labs'

function setNative(lab: NativeLab, on: boolean) {
    const client = createTestQueryClient()
    return client.getMutationCache().build(client, setNativeLabMutation()).execute({lab, on})
}

describe('readLabs', () => {
    it('reads the object the old app wrote, each switch on its own', () => {
        expect(readLabs(JSON.stringify({transcriptScrubbing: true, cleanTranscript: 'yes', meetingAutomation: true}))).toEqual({
            ...DEFAULT_LABS,
            transcriptScrubbing: true,
            meetingAutomation: true,
        })
        expect(readLabs('not json')).toEqual(DEFAULT_LABS)
        expect(readLabs(null)).toEqual(DEFAULT_LABS)
    })
})

describe('useLabsStore', () => {
    it('writes the bare object under the old key, keeping the fields it does not show', () => {
        useLabsStore.setState({value: readLabs(JSON.stringify({meetingAutomation: true}))})
        setLab('cleanTranscript', true)

        expect(JSON.parse(localStorage.getItem(LABS_KEY) ?? '{}')).toEqual({
            ...DEFAULT_LABS,
            meetingAutomation: true,
            cleanTranscript: true,
        })
    })
})

describe('the native switches', () => {
    it('changes native, and leaves it as it was when native refuses', async () => {
        await setNative('whisperSilenceGuard', true)
        expect(mockState.labs.whisperSilenceGuard).toBe(true)
        expect(await createTestQueryClient().fetchQuery(nativeLabQuery('whisperSilenceGuard'))).toBe(true)

        // Tests run as Linux, where native refuses the GPU.
        await expect(setNative('parakeetGpu', true)).rejects.toThrow('Windows-only')
        expect(mockState.labs.parakeetGpu).toBe(false)
    })
})
