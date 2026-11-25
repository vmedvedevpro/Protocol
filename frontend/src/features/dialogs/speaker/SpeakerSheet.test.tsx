import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {mockState} from '@/mocks/state'
import {renderDialogs} from '../testing'

const MEETING = 'meeting-untitled'
const lines = () => mockState.meetings.transcripts[MEETING]
const speakers = () => lines().map((line) => line.speaker)

async function open(speaker: string, lineIds = lines().filter((line) => line.speaker === speaker).slice(0, 1).map((line) => line.id)) {
    renderDialogs({kind: 'speaker', meetingId: MEETING, speaker, lineIds})
    const dialog = await screen.findByRole('dialog', {name: 'Who said this line?'})
    await within(dialog).findByText(lines().find((line) => line.id === lineIds[0])!.text)
    return dialog
}

describe('SpeakerSheet', () => {
    it('gives a voice a contact on every line, and quotes the line', async () => {
        const dialog = await open('Speaker 1')
        await userEvent.type(within(dialog).getByRole('searchbox', {name: 'Search contacts or type a name'}), 'pri')
        await userEvent.click(await within(dialog).findByRole('radio', {name: /Priya Shah/}))
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save'}))
        expect(await screen.findByText('Speaker 1 is now Priya Shah')).toBeInTheDocument()
        expect(speakers()).not.toContain('Speaker 1')
        expect(speakers().filter((speaker) => speaker === 'Priya Shah')).toHaveLength(2)
    })

    it('names only this line, a new contact', async () => {
        const dialog = await open('Speaker 1')
        await userEvent.type(within(dialog).getByRole('searchbox', {name: 'Search contacts or type a name'}), 'Dana Wu')
        await userEvent.click(within(dialog).getByRole('radio', {name: 'New contact “Dana Wu”'}))
        await userEvent.click(within(dialog).getByRole('radio', {name: 'Just this line'}).closest('label')!)
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save'}))
        expect(await screen.findByText('This line is now Dana Wu’s')).toBeInTheDocument()
        expect(speakers().filter((speaker) => speaker === 'Speaker 1')).toHaveLength(1)
        expect(speakers()).toContain('Dana Wu')
    })

    it('merges a voice into another of the meeting', async () => {
        const dialog = await open('Speaker 2')
        expect(within(dialog).queryByRole('radio', {name: 'You'})).not.toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('radio', {name: 'Speaker 1'}))
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save'}))
        await screen.findByText('Speaker 2 is now Speaker 1')
        expect(speakers()).not.toContain('Speaker 2')
    })

    it('asks for a pick before saving', async () => {
        const dialog = await open('Speaker 1')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save'}))
        expect(await screen.findByText('Pick who said it')).toBeInTheDocument()
        expect(screen.getByRole('dialog', {name: 'Who said this line?'})).toBeInTheDocument()
    })

    it('renames a voice of a recording in its session', async () => {
        const rename = vi.fn(() => Promise.resolve())
        renderDialogs({
            kind: 'speaker',
            speaker: 'Speaker 2',
            lineIds: ['live-2'],
            live: {
                lines: [
                    {id: 'live-1', text: 'Hello there.', start: 1, speaker: 'You'},
                    {id: 'live-2', text: 'Hi, good to see you.', start: 4, speaker: 'Speaker 2'},
                ],
                rename,
            },
        })
        const dialog = await screen.findByRole('dialog', {name: 'Who said this line?'})
        expect(within(dialog).getByText('Hi, good to see you.')).toBeInTheDocument()
        expect(within(dialog).queryByRole('group', {name: 'Change'})).not.toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('radio', {name: /This is me/}))
        await userEvent.click(within(dialog).getByRole('button', {name: 'Save'}))
        await waitFor(() => expect(rename).toHaveBeenCalledWith('Speaker 2', 'You'))
    })
})
