import type {ReactNode} from 'react'
import {QueryClientProvider, useQuery} from '@tanstack/react-query'
import {emitMockEvent} from '@/mocks/ipc'
import {renderHook, waitFor} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {
    normalizeVocabulary,
    POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT,
    postCallConfigQuery,
    saveGlobalVocabularyMutation,
    savePostCallConfigMutation,
    saveTranscriptConfigMutation,
    TRANSCRIPT_CONFIG_CHANGED_EVENT,
    transcriptConfigQuery,
    useSpeechConfigSync,
    vocabularyQuery,
} from './speech'

const listening = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('normalizeVocabulary', () => {
    it('keeps one of each term per line, as native stores the list', () => {
        expect(normalizeVocabulary(' Acme, Priya Shah\r\nacme\n\n,Parakeet ')).toBe('Acme\nPriya Shah\nParakeet')
        expect(normalizeVocabulary(' , \n ')).toBe('')
    })
})

describe('the transcript config', () => {
    it('saves the live model and shows it before the save lands', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(transcriptConfigQuery)

        const saving = client.getMutationCache().build(client, saveTranscriptConfigMutation())
            .execute({provider: 'localWhisper', model: 'large-v3-turbo-q5_0'})
        await waitFor(() => expect(client.getQueryData(transcriptConfigQuery.queryKey)).toMatchObject({provider: 'localWhisper'}))
        await saving

        expect(mockState.speech.transcriptConfig).toMatchObject({provider: 'localWhisper', model: 'large-v3-turbo-q5_0'})
    })

    it('stores no model when the after-meeting model follows the live one', async () => {
        const client = createTestQueryClient()
        const save = (config: {provider: 'live' | 'whisper', model: string}) =>
            client.getMutationCache().build(client, savePostCallConfigMutation()).execute(config)

        await save({provider: 'whisper', model: 'large-v3-turbo-q5_0'})
        expect(mockState.speech.postCallConfig).toEqual({provider: 'whisper', model: 'large-v3-turbo-q5_0'})
        await save({provider: 'live', model: 'large-v3-turbo-q5_0'})
        expect(await client.fetchQuery(postCallConfigQuery)).toEqual({provider: 'live', model: ''})
    })

    it('answers the vocabulary normalised and refuses a list over the limit', async () => {
        const client = createTestQueryClient()
        const save = (vocabulary: string) =>
            client.getMutationCache().build(client, saveGlobalVocabularyMutation()).execute(vocabulary)

        await expect(save('Kubernetes, kubernetes\nOrca')).resolves.toBe('Kubernetes\nOrca')
        expect((await client.fetchQuery(vocabularyQuery())).global).toBe('Kubernetes\nOrca')
        await expect(save('x'.repeat(1001))).rejects.toThrow('1000 characters or fewer')
        expect(mockState.speech.vocabulary.global).toBe('Kubernetes\nOrca')
    })

    it('reads both models again when native code changes them', async () => {
        const client = createTestQueryClient()
        const wrapper = ({children}: {children: ReactNode}) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
        const {result} = renderHook(() => {
            useSpeechConfigSync()
            return {live: useQuery(transcriptConfigQuery).data, postCall: useQuery(postCallConfigQuery).data}
        }, {wrapper})
        await waitFor(() => expect(result.current.postCall).toEqual({provider: 'live', model: ''}))
        await listening()

        // A Whisper download with enablePostCall activates it natively.
        mockState.speech.postCallConfig = {provider: 'whisper', model: 'large-v3-turbo-q5_0'}
        mockState.speech.transcriptConfig = {provider: 'localWhisper', model: 'large-v3-turbo-q5_0', apiKey: null}
        await emitMockEvent(POST_CALL_TRANSCRIPT_CONFIG_CHANGED_EVENT, null)
        await emitMockEvent(TRANSCRIPT_CONFIG_CHANGED_EVENT, null)

        await waitFor(() => expect(result.current.postCall).toEqual({provider: 'whisper', model: 'large-v3-turbo-q5_0'}))
        await waitFor(() => expect(result.current.live?.provider).toBe('localWhisper'))
    })
})
