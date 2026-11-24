import type {QueryClient} from '@tanstack/react-query'
import {describe, expect, it, vi} from 'vitest'
import {handlers, type MockArgs} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {createTestQueryClient} from '@/test/queryClient'
import {
    audioDevicesQuery,
    deviceKeys,
    deviceLabel,
    deviceValue,
    type RecordingPreferencesPatch,
    recordingPreferencesQuery,
    updateRecordingPreferencesMutation,
} from './devices'

function update(client: QueryClient, patch: RecordingPreferencesPatch) {
    return client.getMutationCache().build(client, updateRecordingPreferencesMutation()).execute(patch)
}

const zoom = {id: 'Zoom.exe', name: 'Zoom', executable: 'Zoom.exe'}
const teams = {id: 'ms-teams.exe', name: 'Microsoft Teams', executable: 'ms-teams.exe'}

describe('audio devices', () => {
    it('stores a device with its type and shows it without', async () => {
        const devices = await createTestQueryClient().fetchQuery(audioDevicesQuery)

        expect(devices.map(deviceValue)).toContain('MacBook Pro Microphone (input)')
        expect(devices.map(deviceValue)).toContain('MacBook Pro Speakers (output)')
        expect(deviceLabel('JBL Tune 770NC (System Audio) (output)')).toBe('JBL Tune 770NC (System Audio)')
    })
})

describe('updateRecordingPreferencesMutation', () => {
    it('writes the whole stored object back, with fields the UI never shows', async () => {
        mockState.devices.recordingPreferences = {
            ...mockState.devices.recordingPreferences,
            file_format: 'mp4',
            system_audio_backend: 'coreaudio',
            real_time_transcription: true,
            preferred_system_device: 'MacBook Pro Speakers (output)',
        }

        await update(createTestQueryClient(), {mic_gain: 1.5})

        expect(mockState.devices.recordingPreferences).toMatchObject({
            mic_gain: 1.5,
            file_format: 'mp4',
            system_audio_backend: 'coreaudio',
            real_time_transcription: true,
            preferred_system_device: 'MacBook Pro Speakers (output)',
        })
    })

    it('reads again before each write, so changes made at once all land', async () => {
        const read = handlers.get_recording_preferences
        let reads = 0
        // The first read takes its copy at once and answers a macrotask
        // later; an update that did not wait for it would write that stale
        // copy over the other change.
        vi.spyOn(handlers, 'get_recording_preferences').mockImplementation(async (args: MockArgs) => {
            const copy = read(args)
            if (reads++ === 0) await settleIpc()
            return copy
        })

        const client = createTestQueryClient()
        await Promise.all([
            update(client, {preferred_mic_device: 'Studio Display Microphone (input)'}),
            update(client, {system_gain: 2}),
        ])

        expect(mockState.devices.recordingPreferences).toMatchObject({
            preferred_mic_device: 'Studio Display Microphone (input)',
            system_gain: 2,
        })
    })

    it('goes on after a failed update', async () => {
        vi.spyOn(handlers, 'set_recording_preferences').mockImplementationOnce(() => {
            throw 'Failed to save recording preferences: Recording directory is not writable'
        })

        const client = createTestQueryClient()
        await expect(update(client, {save_folder: '/read-only'})).rejects.toThrow('not writable')
        await update(client, {auto_save: false})

        expect(mockState.devices.recordingPreferences.save_folder).not.toBe('/read-only')
        expect(mockState.devices.recordingPreferences.auto_save).toBe(false)
    })

    it('keeps the legacy single-app fields on the first chosen app, and empty with none', async () => {
        const client = createTestQueryClient()
        await update(client, {per_app_targets: [teams, zoom]})
        expect(mockState.devices.recordingPreferences).toMatchObject({
            per_app_target_app: 'ms-teams.exe',
            per_app_target_name: 'Microsoft Teams',
        })

        await update(client, {per_app_targets: []})
        // Native would bring Teams back from a stale legacy field.
        expect(mockState.devices.recordingPreferences).toMatchObject({
            per_app_targets: [],
            per_app_target_app: null,
            per_app_target_name: null,
        })
    })
})

describe('the cached preferences', () => {
    it('show the change at once and reads the stored object again after it', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(recordingPreferencesQuery)
        const write = handlers.set_recording_preferences
        let release = () => {}
        vi.spyOn(handlers, 'set_recording_preferences').mockImplementation(async (args: MockArgs) => {
            await new Promise<void>((resolve) => (release = resolve))
            return write(args)
        })

        const saving = update(client, {auto_save: false})
        await settleIpc()
        expect(client.getQueryData(recordingPreferencesQuery.queryKey)?.auto_save).toBe(false)

        release()
        await saving
        expect(client.getQueryState(deviceKeys.recordingPreferences())?.isInvalidated).toBe(true)
        expect(mockState.devices.recordingPreferences.auto_save).toBe(false)
    })
})
