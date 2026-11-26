import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {logsFileName} from '@/api/logs'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../pages/SettingsPage'
import {renderSettings} from '../testing'

const openAdvanced = () => renderSettings(createElement(SettingsPage), '/settings?section=advanced')
const group = () => screen.findByRole('region', {name: 'Bug reports'})

describe('Bug reports', () => {
    it('saves the logs where the dialog says and offers to show the file', async () => {
        mockState.saveDialogPath = '/home/user/Protocol-logs-2026-11-26.zip'
        openAdvanced()
        const logs = await group()
        expect(within(logs).getByText(/leave out recordings, transcripts and keys/)).toBeInTheDocument()

        await userEvent.click(within(logs).getByRole('button', {name: 'Save logs'}))
        expect(await within(logs).findByRole('status')).toHaveTextContent('Saved as Protocol-logs-2026-11-26.zip')
        expect(mockState.logs.zips).toEqual(['/home/user/Protocol-logs-2026-11-26.zip'])

        await userEvent.click(within(logs).getByRole('button', {name: 'Show in folder'}))
        await waitFor(() => expect(mockState.logs.shown).toEqual(['/home/user/Protocol-logs-2026-11-26.zip']))
    })

    it('does nothing when the dialog is cancelled', async () => {
        mockState.saveDialogPath = null
        openAdvanced()
        const logs = await group()
        await userEvent.click(within(logs).getByRole('button', {name: 'Save logs'}))
        await waitFor(() => expect(within(logs).getByRole('button', {name: 'Save logs'})).toBeEnabled())
        expect(mockState.logs.zips).toEqual([])
        expect(within(logs).queryByText(/Saved as/)).not.toBeInTheDocument()
    })

    it('says why the log is not written, in place of its description', async () => {
        mockState.logs.status = {
            problem: 'Protocol cannot write its log to /home/user/.local/share/vmedvedevpro/Protocol/logs: Permission denied',
        }
        openAdvanced()
        const logs = await group()
        expect(await within(logs).findByText(/Protocol cannot write its log to .*Permission denied/)).toBeInTheDocument()
        expect(within(logs).queryByText(/leave out recordings/)).not.toBeInTheDocument()
        // The earlier files can still be saved.
        expect(within(logs).getByRole('button', {name: 'Save logs'})).toBeEnabled()
    })

    it('names the file after the day', () => {
        expect(logsFileName(new Date(2026, 0, 5, 23, 30))).toBe('Protocol-logs-2026-01-05.zip')
    })
})
