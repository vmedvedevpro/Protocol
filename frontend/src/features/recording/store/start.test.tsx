import {waitFor} from '@testing-library/react'
import {describe, expect, it, vi} from 'vitest'
import {mockState} from '@/mocks/state'
import {spyOnIpc} from '@/test/ipc'
import {RecordingRuntime} from '../components/RecordingRuntime'
import {renderRecording, toastTitles} from '../test/renderRecording'
import {registerLinks} from './links'
import {session} from './session'
import {startRecording} from './start'

describe('startRecording', () => {
    it('loads the speech model, then records from the chosen devices under an automatic title', async () => {
        const openRecording = vi.fn()
        renderRecording(<RecordingRuntime/>)
        registerLinks({openRecording, openMeeting: () => {}, openSpeechModels: () => {}})
        mockState.devices.recordingPreferences.preferred_mic_device = 'Studio Display Microphone'
        const invoke = spyOnIpc()

        expect(await startRecording()).toBe(true)

        const commands = invoke.mock.calls.map(([command]) => command)
        expect(commands.indexOf('check_transcription_runtime')).toBeLessThan(commands.indexOf('parakeet_load_model'))
        expect(commands.indexOf('parakeet_load_model')).toBeLessThan(commands.indexOf('start_recording_with_devices_and_meeting'))
        expect(mockState.live.recording).toMatchObject({micDevice: 'Studio Display Microphone', systemDevice: null})
        expect(mockState.live.recording?.meetingName).toMatch(/^Meeting, /)
        expect(openRecording).toHaveBeenCalledTimes(1)
        expect(session.get()).toMatchObject({phase: 'recording', title: mockState.live.recording?.meetingName})
        expect(session.get().recoveryId).toMatch(/^meeting-\d+$/)
    })

    it('titles the recording after the folder picked for it', async () => {
        renderRecording(<RecordingRuntime/>)
        session.set({folder: {id: 'group-acme', name: 'Acme'}})

        await startRecording()

        expect(mockState.live.recording?.meetingName).toMatch(/^Acme — /)
    })

    it('does not record without a speech model, and offers Speech models', async () => {
        renderRecording(<RecordingRuntime/>)
        mockState.models.parakeet = 'Missing'

        expect(await startRecording()).toBe(false)

        expect(session.get().phase).toBe('idle')
        expect(mockState.live.recording).toBeNull()
        expect(toastTitles()).toEqual(['No speech model yet'])
    })

    it('says why the speech runtime cannot run', async () => {
        renderRecording(<RecordingRuntime/>)
        mockState.live.runtimeError = 'ONNX Runtime could not be loaded'

        expect(await startRecording()).toBe(false)

        expect(toastTitles()).toEqual(['Speech recognition unavailable'])
        expect(session.get().phase).toBe('idle')
    })

    it('goes back to idle with native’s reason when capture cannot start', async () => {
        renderRecording(<RecordingRuntime/>)
        mockState.live.startError = 'Failed to start recording: The microphone is in use by another app'

        expect(await startRecording()).toBe(false)

        await waitFor(() => expect(toastTitles()).toHaveLength(1))
        expect(session.get()).toMatchObject({phase: 'idle', startedAt: null})
    })

    it('does nothing while a recording runs', async () => {
        renderRecording(<RecordingRuntime/>)
        await startRecording()
        const invoke = spyOnIpc()

        expect(await startRecording()).toBe(false)
        expect(invoke).not.toHaveBeenCalled()
    })
})
