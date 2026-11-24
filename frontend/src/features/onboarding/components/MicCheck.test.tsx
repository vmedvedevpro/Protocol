import {QueryClientProvider} from '@tanstack/react-query'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {Platform} from '@/lib/platform'
import {handlers} from '@/mocks/handlers'
import {MOCK_SPEAKERS} from '@/mocks/devices'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {MicCheck} from './MicCheck'

function renderMicCheck(platform: Platform) {
    mockState.platform = platform
    return renderUi(
        <QueryClientProvider client={createTestQueryClient()}>
            <MicCheck platform={platform}/>
        </QueryClientProvider>,
    )
}

describe('MicCheck', () => {
    it('asks for the microphone before it previews it, and keeps the microphone chosen', async () => {
        const ask = vi.spyOn(handlers, 'trigger_microphone_permission')
        const preview = vi.spyOn(handlers, 'start_audio_level_monitoring')
        renderMicCheck('linux')

        await waitFor(() => expect(preview).toHaveBeenCalled())
        expect(ask.mock.invocationCallOrder[0]).toBeLessThan(preview.mock.invocationCallOrder[0])

        await userEvent.click(screen.getByRole('button', {name: 'Microphone: System default. Change'}))
        await userEvent.click(await screen.findByRole('menuitemradio', {name: 'Studio Display Microphone'}))

        await screen.findByRole('button', {name: 'Microphone: Studio Display Microphone. Change'})
        expect(mockState.devices.recordingPreferences.preferred_mic_device).toBe('Studio Display Microphone (input)')
        await waitFor(() => expect(mockState.audio.monitoring).toContain('Studio Display Microphone'))
    })

    it('says when the microphone does not open, and asks again', async () => {
        mockState.permissions.microphone = false
        renderMicCheck('macos')

        expect(await screen.findByText('Protocol can’t open the microphone.')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Open System Settings'}))
        expect(mockState.permissions.openedPanes).toEqual(['Privacy_Microphone'])

        mockState.permissions.microphone = true
        await userEvent.click(screen.getByRole('button', {name: 'Try again'}))

        await waitFor(() => expect(screen.queryByText('Protocol can’t open the microphone.')).not.toBeInTheDocument())
    })

    it('hears the computer audio through the output on Windows and Linux', async () => {
        mockState.audio.level = 0.5
        renderMicCheck('windows')
        await waitFor(() => expect(mockState.audio.monitoring).toContain(MOCK_SPEAKERS))

        await userEvent.click(screen.getByRole('button', {name: 'Test computer audio'}))

        expect(await screen.findByText('Protocol hears your computer audio.')).toBeInTheDocument()
    })

    it('runs the Audio Capture probe on macOS, and points to System Settings when it is refused', async () => {
        mockState.permissions.systemAudio = 'not_determined'
        mockState.permissions.answer = 'denied'
        renderMicCheck('macos')

        await userEvent.click(await screen.findByRole('button', {name: 'Test computer audio'}))

        expect(await screen.findByText('macOS doesn’t let Protocol record the computer audio.')).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Open System Settings'}))
        expect(mockState.permissions.openedPanes).toEqual(['Privacy_AudioCapture'])
    })
})
