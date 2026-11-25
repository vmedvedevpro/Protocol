import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../pages/SettingsPage'
import {renderSettings} from '../testing'

const open = () => renderSettings(createElement(SettingsPage), '/settings/chosen-apps')
const group = (name: string) => screen.findByRole('region', {name})
const targets = () => mockState.devices.recordingPreferences.per_app_targets

describe('Chosen apps page', () => {
    it('offers the open apps, those playing sound first, and adds one', async () => {
        open()
        const playing = await group('Playing sound now')
        expect(within(playing).getByText('Zoom Workplace')).toBeInTheDocument()
        expect(within(await group('Open apps')).getByText('Slack')).toBeInTheDocument()
        expect(within(await group('Recording these apps')).getByText('No apps yet')).toBeInTheDocument()

        await userEvent.click(within(playing).getAllByRole('button', {name: 'Add'})[0])
        await waitFor(() => expect(targets()).toEqual([expect.objectContaining({id: 'Zoom.exe', executable: 'Zoom.exe'})]))
        const chosen = await group('Recording these apps')
        expect(await within(chosen).findByText('Zoom Workplace')).toBeInTheDocument()
        expect(within(playing).queryByText('Zoom Workplace')).not.toBeInTheDocument()

        await userEvent.click(within(chosen).getByRole('button', {name: 'Remove'}))
        await waitFor(() => expect(targets()).toEqual([]))
    })

    it('searches the open apps', async () => {
        open()
        await group('Open apps')
        await userEvent.type(screen.getByRole('searchbox', {name: 'Add an app'}), 'disc')
        expect(screen.getByText('Discord')).toBeInTheDocument()
        expect(screen.queryByText('Slack')).not.toBeInTheDocument()

        await userEvent.type(screen.getByRole('searchbox', {name: 'Add an app'}), 'xyz')
        expect(screen.getByText('No open app matches “discxyz”')).toBeInTheDocument()
    })

    it('adds an app that is not open from the picker', async () => {
        open()
        await userEvent.click(await screen.findByRole('button', {name: 'Browse…'}))
        await waitFor(() => expect(targets()).toEqual([expect.objectContaining({name: 'Webex', executable: 'CiscoCollabHost.exe'})]))
    })
})
