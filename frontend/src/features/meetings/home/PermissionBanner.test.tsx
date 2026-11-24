import {QueryClientProvider} from '@tanstack/react-query'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import type {Platform} from '@/lib/platform'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {needsPermissionBanner, useAudioAccess} from './audioAccess'
import {PermissionBanner} from './PermissionBanner'

/** The banner as Home shows it, on `on`. */
function Home({on}: { on: Platform }) {
    const access = useAudioAccess(on)
    return needsPermissionBanner(access, on) && access ? <PermissionBanner access={access} on={on}/> : <p>No banner</p>
}

const renderOn = (on: Platform) => {
    mockState.platform = on === 'macos' ? 'macos' : 'windows'
    return renderUi(<QueryClientProvider client={createTestQueryClient()}><Home on={on}/></QueryClientProvider>)
}

describe('PermissionBanner', () => {
    it('shows nothing while Protocol hears both sources', async () => {
        renderOn('macos')
        expect(await screen.findByText('No banner')).toBeInTheDocument()
    })

    it('on macOS, says Audio Capture is off and opens its pane', async () => {
        mockState.permissions.systemAudio = 'denied'
        renderOn('macos')
        expect(await screen.findByText('Protocol can’t hear your computer audio')).toBeInTheDocument()
        expect(screen.getByText(/Audio Capture is turned off/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Audio Capture settings'}))
        expect(mockState.permissions.openedPanes).toEqual(['Privacy_AudioCapture'])
    })

    it('says no microphone was found, and Check again reads the devices anew', async () => {
        const all = mockState.devices.list
        mockState.devices.list = all.filter((device) => device.device_type !== 'Input')
        renderOn('windows')
        expect(await screen.findByText('Protocol can’t hear your microphone')).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: /settings/})).not.toBeInTheDocument()

        mockState.devices.list = all
        await userEvent.click(screen.getByRole('button', {name: 'Check again'}))
        await waitFor(() => expect(screen.getByText('No banner')).toBeInTheDocument())
    })

    it('shows none on Linux, which asks for no permission', async () => {
        mockState.devices.list = []
        renderOn('linux')
        expect(await screen.findByText('No banner')).toBeInTheDocument()
    })
})
