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
} from './models'
import {GPU_VERSION_ID} from '@/mocks/intel'
import {createMockModels} from '@/mocks/models'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {companionQuery, downloadGpuVersion, INTEL_CANCELLED} from './intel'
import {trackIntelDownload, useModelDownloadSync} from './modelDownloadSync'

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
        // Any percent: the fake steps every 250 ms, and a busy machine checks late.
        await waitFor(() => expect(result.current.summary).toMatchObject({kind: 'downloading'}))

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

        expect(mockState.speech.postCallConfig).toEqual({provider: 'whisper', model: POST_CALL_WHISPER_MODEL})
        await waitFor(() => expect(result.current.whisper).toEqual({kind: 'ready'}))
    })
})

describe('trackIntelDownload', () => {
    function renderIntel() {
        mockState.platform = 'windows'
        mockState.intel.gpu = true
        const client = createTestQueryClient()
        const wrapper = ({children}: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
        const view = renderHook(() => {
            useModelDownloadSync()
            const companion = useQuery(companionQuery).data
            return {companion, state: useQuery(downloadsQuery).data[downloadKey('intelGpu', GPU_VERSION_ID)]}
        }, {wrapper})
        return {client, ...view}
    }

    it('keeps the record until the Intel GPU version reads as installed', async () => {
        mockState.intel.downloadStep = 50
        const {client, result} = renderIntel()
        await waitFor(() => expect(result.current.companion?.installed).toBe(false))
        await listening()

        const done = trackIntelDownload(client, 'intelGpu', GPU_VERSION_ID, () => downloadGpuVersion(GPU_VERSION_ID, {choose: true}))
        await waitFor(() => expect(result.current.state).toMatchObject({state: 'downloading'}))
        await done

        await waitFor(() => expect(result.current.companion?.installed).toBe(true))
        expect(result.current.state).toBeUndefined()
    })

    it('keeps a failure, which native sends no event for, and forgets a cancel', async () => {
        const {client, result} = renderIntel()
        await listening()

        await expect(trackIntelDownload(client, 'intelGpu', GPU_VERSION_ID, () => Promise.reject(new Error('Network down')))).rejects.toThrow()
        await waitFor(() => expect(result.current.state).toEqual({state: 'failed', error: 'Network down'}))

        await expect(trackIntelDownload(client, 'intelGpu', GPU_VERSION_ID, () => Promise.reject(new Error(INTEL_CANCELLED)))).rejects.toThrow()
        await waitFor(() => expect(result.current.state).toBeUndefined())
    })
})
