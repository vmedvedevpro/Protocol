import {createElement} from 'react'
import {act, fireEvent, renderHook, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {recordingPhase} from '@/api/recordingPhase'
import {useDialog} from '@/lib/dialogs'
import type {Platform} from '@/lib/platform'
import {mockState} from '@/mocks/state'
import {settleIpc} from '@/test/ipc'
import {renderSettings} from '../testing'
import {RecordingSection} from './RecordingSection'

const renderRecording = (platform: Platform = 'windows') =>
    renderSettings(createElement(RecordingSection, {platform}))
const group = (name: string) => screen.findByRole('region', {name})
const stored = () => mockState.devices.recordingPreferences

const zoom = {id: 'Zoom.exe', name: 'Zoom', executable: 'Zoom.exe'}
const teams = {id: 'ms-teams.exe', name: 'Microsoft Teams', executable: 'ms-teams.exe'}

describe('Recording › Saving', () => {
    it('shows the folder, and warns instead when audio is not saved', async () => {
        renderRecording()
        expect(await screen.findByText(stored().save_folder)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('switch', {name: 'Save audio'}))

        await waitFor(() => expect(stored().auto_save).toBe(false))
        expect(screen.getByText(/Audio isn’t being saved/)).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByText('Where recordings are saved')).not.toBeInTheDocument())
    })

    it('changes the folder to the one picked, and keeps it on Cancel', async () => {
        const picked = mockState.devices.pickedFolder
        renderRecording()
        await userEvent.click(await screen.findByRole('button', {name: 'Change'}))

        await waitFor(() => expect(stored().save_folder).toBe(picked))
        expect(await screen.findByText('Recordings folder changed')).toBeInTheDocument()

        mockState.devices.pickedFolder = null
        await userEvent.click(screen.getByRole('button', {name: 'Change'}))
        expect(stored().save_folder).toBe(picked)
    })

    it('opens the folder', async () => {
        renderRecording()
        await userEvent.click(await screen.findByRole('button', {name: 'Open'}))

        await waitFor(() => expect(mockState.devices.openedFolders).toEqual([stored().save_folder]))
    })
})

describe('Recording › volumes', () => {
    it('saves the mic volume once the slider rests, keeping the other fields', async () => {
        mockState.devices.recordingPreferences = {...stored(), real_time_transcription: true}
        renderRecording()
        const slider = await screen.findByRole('slider', {name: 'Mic volume'})
        await waitFor(() => expect(slider).toBeEnabled())

        fireEvent.change(slider, {target: {value: '1.6'}})
        fireEvent.change(slider, {target: {value: '1.8'}})

        expect(screen.getByText('1.8×')).toBeInTheDocument()
        await waitFor(() => expect(stored().mic_gain).toBe(1.8))
        expect(stored().real_time_transcription).toBe(true)
    })

    it('keeps a change made just before the page is left', async () => {
        const {unmount} = renderRecording()
        const slider = await screen.findByRole('slider', {name: 'System volume'})
        await waitFor(() => expect(slider).toBeEnabled())

        fireEvent.change(slider, {target: {value: '2.5'}})
        unmount()

        await waitFor(() => expect(stored().system_gain).toBe(2.5))
    })
})

describe('Recording › Computer audio', () => {
    it('records only chosen apps, and removes one', async () => {
        mockState.devices.recordingPreferences = {...stored(), per_app_targets: [zoom, teams]}
        renderRecording()
        const audio = within(await group('Computer audio'))

        // The radio is hidden under its label, which takes the click.
        await userEvent.click(audio.getByRole('radio', {name: 'Only chosen apps'}).closest('label')!)
        await waitFor(() => expect(stored().per_app_recording_enabled).toBe(true))
        await userEvent.click(await audio.findByRole('button', {name: 'Remove Zoom'}))

        await waitFor(() => expect(stored().per_app_targets).toEqual([teams]))
        // Native's legacy fields follow the first app.
        expect(stored().per_app_target_app).toBe('ms-teams.exe')
    })

    it('adds apps on their own page', async () => {
        mockState.devices.recordingPreferences = {...stored(), per_app_recording_enabled: true}
        const {router} = renderRecording()

        await userEvent.click(await screen.findByRole('button', {name: '+ Add app'}))

        expect(router.state.location.pathname).toBe('/settings/chosen-apps')
    })

    it('has no app choice on Linux', async () => {
        renderRecording('linux')
        const audio = within(await group('Computer audio'))

        expect(audio.queryByRole('radiogroup', {name: 'Record'})).not.toBeInTheDocument()
        expect(audio.getByRole('combobox', {name: 'System audio'})).toBeInTheDocument()
    })

    it('records the current output on macOS', async () => {
        renderRecording('macos')
        const audio = await group('Computer audio')

        expect(within(audio).queryByRole('combobox', {name: 'System audio'})).not.toBeInTheDocument()
        expect(audio).toHaveTextContent('macOS records the current system output.')
    })
})

describe('Recording › devices', () => {
    it('stores the chosen microphone with its type, and shows the default for a missing one, saying so', async () => {
        mockState.devices.recordingPreferences = {...stored(), preferred_system_device: 'USB Headset (output)'}
        renderRecording()

        const output = await screen.findByRole('combobox', {name: 'System audio'})
        await waitFor(() => expect(output).toHaveTextContent('Default output'))
        expect(screen.getByText('USB Headset isn’t connected, so the default is used')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('combobox', {name: 'Microphone'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Studio Display Microphone'}))

        await waitFor(() => expect(stored().preferred_mic_device).toBe('Studio Display Microphone (input)'))
        expect(stored().preferred_system_device).toBe('USB Headset (output)')
    })

    it('opens no device until Test, and stops on a second press', async () => {
        mockState.devices.recordingPreferences = {...stored(), preferred_mic_device: 'Studio Display Microphone (input)'}
        renderRecording()
        const test = await screen.findByRole('button', {name: 'Test'})
        await waitFor(() => expect(test).toBeEnabled())
        await settleIpc()
        expect(mockState.audio.monitoring).toBeNull()

        await userEvent.click(test)
        await waitFor(() => expect(mockState.audio.monitoring).toEqual(['Studio Display Microphone']))

        await userEvent.click(screen.getByRole('button', {name: 'Stop'}))
        await waitFor(() => expect(mockState.audio.monitoring).toBeNull())
    })

    it('ends the test when another microphone is chosen, and tests that one next', async () => {
        renderRecording()
        await userEvent.click(await screen.findByRole('button', {name: 'Test'}))
        await waitFor(() => expect(mockState.audio.monitoring).not.toBeNull())

        await userEvent.click(screen.getByRole('combobox', {name: 'Microphone'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Studio Display Microphone'}))

        await waitFor(() => expect(mockState.audio.monitoring).toBeNull())
        // The rest of the window is hidden from assistive technology until the list has closed.
        await userEvent.click(await screen.findByRole('button', {name: 'Test'}))
        await waitFor(() => expect(mockState.audio.monitoring).toEqual(['Studio Display Microphone']))
    })

    it('ends the test when the section closes or a recording starts', async () => {
        const {unmount} = renderRecording()
        await userEvent.click(await screen.findByRole('button', {name: 'Test'}))
        await waitFor(() => expect(mockState.audio.monitoring).not.toBeNull())

        act(() => recordingPhase.set('starting'))
        await waitFor(() => expect(mockState.audio.monitoring).toBeNull())
        expect(screen.getByRole('button', {name: 'Test'})).toBeDisabled()

        act(() => recordingPhase.set('idle'))
        await settleIpc()
        // It does not come back on its own.
        expect(mockState.audio.monitoring).toBeNull()

        await userEvent.click(screen.getByRole('button', {name: 'Test'}))
        await waitFor(() => expect(mockState.audio.monitoring).not.toBeNull())
        unmount()
        await waitFor(() => expect(mockState.audio.monitoring).toBeNull())
    })
})

describe('Recording › Import', () => {
    it('opens Import a recording', async () => {
        renderRecording()
        const importDialog = renderHook(() => useDialog())
        const card = await group('Import')
        await userEvent.click(within(card).getByRole('button', {name: 'Choose a file'}))
        expect(importDialog.result.current.open).toBe(true)
    })
})
