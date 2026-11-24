import type {ReactNode} from 'react'
import {QueryClientProvider, useQuery} from '@tanstack/react-query'
import {renderHook, waitFor} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {
    downloadBuiltInModel,
    downloadKey,
    downloadParakeetModel,
    downloadsQuery,
    downloadWhisperModel,
    modelState,
    PARAKEET_MODEL,
    parakeetModelsQuery,
    POST_CALL_WHISPER_MODEL,
    whisperModelsQuery,
    builtInModelsQuery,
} from '@/api/models'
import {createMockModels} from '@/mocks/models'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {useModelDownloadSync} from './useModelDownloadSync'

const listening = () => new Promise((resolve) => setTimeout(resolve, 0))

/** What a screen sees: the three lists, the downloads and the sync that keeps them. */
function useModels() {
    useModelDownloadSync()
    const downloads = useQuery(downloadsQuery).data
    const parakeet = useQuery(parakeetModelsQuery).data?.find(({name}) => name === PARAKEET_MODEL)
    const whisper = useQuery(whisperModelsQuery).data?.find(({name}) => name === POST_CALL_WHISPER_MODEL)
    const summary = useQuery(builtInModelsQuery).data?.find(({name}) => name === 'qwen3.5:4b')
    return {
        parakeet: modelState(parakeet?.status, downloads[downloadKey('parakeet', PARAKEET_MODEL)]),
        whisper: modelState(whisper?.status, downloads[downloadKey('whisper', POST_CALL_WHISPER_MODEL)]),
        summary: modelState(summary?.status, downloads[downloadKey('builtIn', 'qwen3.5:4b')]),
    }
}

function renderModels() {
    const client = createTestQueryClient()
    const wrapper = ({children}: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
    return renderHook(useModels, {wrapper})
}

describe('useModelDownloadSync', () => {
    it('follows a download by its events and reads the list again when it completes', async () => {
        mockState.models = createMockModels({fresh: true})
        mockState.models.downloadStep = 40
        const {result} = renderModels()
        await waitFor(() => expect(result.current.parakeet).toEqual({kind: 'missing'}))
        await listening()

        const done = downloadParakeetModel(PARAKEET_MODEL)

        await waitFor(() => expect(result.current.parakeet).toEqual({kind: 'downloading', progress: 40}))
        await done
        await waitFor(() => expect(result.current.parakeet).toEqual({kind: 'ready'}))
    })

    it('keeps the failure and its message', async () => {
        mockState.models = createMockModels({fresh: true})
        mockState.models.downloadStep = 50
        mockState.models.failing = [downloadKey('builtIn', 'qwen3.5:4b')]
        const {result} = renderModels()
        await waitFor(() => expect(result.current.summary).toEqual({kind: 'missing'}))
        await listening()

        await expect(downloadBuiltInModel('qwen3.5:4b')).rejects.toThrow(/connection reset/)

        await waitFor(() => expect(result.current.summary).toMatchObject({kind: 'failed', error: expect.stringMatching(/connection reset/)}))
    })

    it('keeps a running download going when a second call for it is refused', async () => {
        mockState.models = createMockModels({fresh: true})
        mockState.models.downloadStep = 20
        const {result} = renderModels()
        await waitFor(() => expect(result.current.summary).toEqual({kind: 'missing'}))
        await listening()

        const first = [
            downloadParakeetModel(PARAKEET_MODEL),
            downloadWhisperModel(POST_CALL_WHISPER_MODEL),
            downloadBuiltInModel('qwen3.5:4b'),
        ]
        await waitFor(() => expect(result.current.summary).toEqual({kind: 'downloading', progress: 20}))

        // Native refuses each second call and sends the refusal as an error event.
        await expect(downloadParakeetModel(PARAKEET_MODEL)).rejects.toThrow(/already in progress/)
        await expect(downloadWhisperModel(POST_CALL_WHISPER_MODEL)).rejects.toThrow(/already in progress/)
        await expect(downloadBuiltInModel('qwen3.5:4b')).rejects.toThrow(/already in progress/)
        await listening()

        for (const model of Object.values(result.current)) expect(model.kind).toBe('downloading')
        await Promise.all(first)
        await waitFor(() => expect(result.current).toEqual({parakeet: {kind: 'ready'}, whisper: {kind: 'ready'}, summary: {kind: 'ready'}}))
    })

    it('shows Whisper being enabled, and native code saves it as the after-meeting model before it resolves', async () => {
        mockState.models = createMockModels({fresh: true})
        mockState.models.downloadStep = 50
        const {result} = renderModels()
        await waitFor(() => expect(result.current.whisper).toEqual({kind: 'missing'}))
        await listening()

        await downloadWhisperModel(POST_CALL_WHISPER_MODEL, {enablePostCall: true})

        expect(mockState.models.postCallModel).toBe(POST_CALL_WHISPER_MODEL)
        await waitFor(() => expect(result.current.whisper).toEqual({kind: 'ready'}))
    })
})
