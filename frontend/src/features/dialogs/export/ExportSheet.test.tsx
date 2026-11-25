import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {renderDialogs} from '../testing'
import {LINK_STYLE_KEY} from './exportDocument'

const exportMeeting = (meetingId = 'meeting-acme-review') => renderDialogs({kind: 'export', meetingId})
const written = () => new TextDecoder().decode(mockState.dialogs.writtenFiles.at(-1))

describe('ExportSheet', () => {
    it('offers the whole record as Markdown by default and saves it where the user chooses', async () => {
        mockState.saveDialogPath = '/home/user/acme.md'
        exportMeeting()
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        expect(await within(sheet).findByText('Acme pilot security review')).toBeInTheDocument()
        expect(await within(sheet).findByRole('radio', {name: /Transcript \+ Summary/})).toBeChecked()
        expect(within(sheet).getByRole('radio', {name: /Markdown/})).toBeChecked()

        await userEvent.click(within(sheet).getByRole('button', {name: 'Export'}))
        expect(await screen.findByText('Exported as Markdown')).toBeInTheDocument()
        await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Export'})).not.toBeInTheDocument())
        expect(written()).toMatch(/^---\ntitle: "Acme pilot security review"/)
        expect(written()).toContain('## Summary')
        expect(written()).toContain('## Transcript')
    })

    it('remembers the link style under the old key and links named speakers', async () => {
        mockState.saveDialogPath = '/home/user/acme.md'
        exportMeeting()
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        // The segment's label takes the click; its radio sits under the thumb.
        await userEvent.click((await within(sheet).findByRole('radio', {name: 'Obsidian'})).closest('label') as HTMLElement)
        expect(localStorage.getItem(LINK_STYLE_KEY)).toBe('obsidian')
        expect(within(sheet).getByText('Wikilinks to identified speakers')).toBeInTheDocument()
        await userEvent.click(within(sheet).getByRole('button', {name: 'Export'}))
        await screen.findByText('Exported as Markdown')
        expect(written()).toContain('**[[Priya Shah]]:**')
    })

    it('hides the link style for other formats and saves text', async () => {
        mockState.saveDialogPath = '/home/user/acme.txt'
        exportMeeting()
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        await userEvent.click(await within(sheet).findByRole('radio', {name: /^Transcript Everything said/}))
        await userEvent.click(within(sheet).getByRole('radio', {name: /Text/}))
        expect(within(sheet).queryByRole('radiogroup', {name: 'Link style'})).not.toBeInTheDocument()
        await userEvent.click(within(sheet).getByRole('button', {name: 'Export'}))
        await screen.findByText('Exported as text')
        expect(written()).toMatch(/^Acme pilot security review\n\n.+\n\nTranscript\n\n\[\d\d:\d\d\] /)
        expect(written()).not.toContain('Summary')
    })

    it('stays open when the save dialog is cancelled', async () => {
        mockState.saveDialogPath = null
        exportMeeting()
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        await within(sheet).findByRole('radio', {name: /Transcript \+ Summary/})
        await userEvent.click(within(sheet).getByRole('button', {name: 'Export'}))
        await waitFor(() => expect(within(sheet).getByRole('button', {name: 'Export'})).toBeEnabled())
        expect(screen.getByRole('dialog', {name: 'Export'})).toBeInTheDocument()
        expect(mockState.dialogs.writtenFiles).toHaveLength(0)
    })

    it('says so when the file cannot be written', async () => {
        mockState.saveDialogPath = '/home/user/acme.md'
        mockState.dialogs.writeError = 'Permission denied'
        exportMeeting()
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        await within(sheet).findByRole('radio', {name: /Transcript \+ Summary/})
        await userEvent.click(within(sheet).getByRole('button', {name: 'Export'}))
        expect(await screen.findByText('Export failed')).toBeInTheDocument()
        expect(screen.getByText('Permission denied')).toBeInTheDocument()
        expect(screen.getByRole('dialog', {name: 'Export'})).toBeInTheDocument()
    })

    it('copies to the clipboard without frontmatter', async () => {
        const user = userEvent.setup()
        exportMeeting()
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        await user.click(await within(sheet).findByRole('radio', {name: /Clipboard/}))
        await user.click(within(sheet).getByRole('button', {name: 'Copy'}))
        expect(await screen.findByText('Transcript and summary copied')).toBeInTheDocument()
        expect(await navigator.clipboard.readText()).toMatch(/^# Acme pilot security review\n/)
    })

    it('offers only the transcript of a meeting without a summary', async () => {
        exportMeeting('meeting-untitled')
        const sheet = await screen.findByRole('dialog', {name: 'Export'})
        expect(await within(sheet).findByRole('radio', {name: /^Transcript Everything said/})).toBeChecked()
        expect(within(sheet).getByRole('radio', {name: /^Summary/})).toBeDisabled()
        expect(within(sheet).getByRole('radio', {name: /Transcript \+ Summary/})).toBeDisabled()
    })
})
