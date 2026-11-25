import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {createActionItem} from '@/api/actionItems'
import {renderRoute} from '@/features/meetings/testing'
import {handlers, type MockArgs} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {PersonRoute} from './PersonScreen'

const renderPerson = (personId: string) => renderRoute(`/person/${personId}`, [
    {path: '/person/:personId', element: <PersonRoute/>},
    {path: '/', element: <h1>Home</h1>},
])

describe('PersonScreen', () => {
    it('shows the details, the meetings together and the private notes', async () => {
        renderPerson('person-priya')

        expect(await screen.findByRole('heading', {level: 1, name: 'Priya Shah'})).toBeInTheDocument()
        expect(screen.getByText('Product Manager · Meetily')).toBeInTheDocument()
        const details = screen.getByRole('region', {name: 'Details'})
        expect(details).toHaveTextContent('priya@example.com')
        expect(details).toHaveTextContent('PhoneNot added')
        const meetings = screen.getByRole('region', {name: 'Meetings together'})
        expect(within(meetings).getByRole('link', {name: /Acme pilot security review/})).toHaveAttribute('href', '/meetings/meeting-acme-review')
        expect(screen.getByRole('textbox', {name: 'Private notes'})).toHaveValue('Prefers short written updates. Owns the pilot config.')
        // Voice profiles are off and Priya has no voice yet: no Labs section.
        expect(screen.queryByRole('region', {name: 'Voice'})).not.toBeInTheDocument()
    })

    it('saves the notes when typing pauses', async () => {
        renderPerson('person-marcus')
        const notes = await screen.findByRole('textbox', {name: 'Private notes'})

        await userEvent.type(notes, 'Owns the player.')

        await waitFor(() => expect(mockState.people.rows.find((person) => person.id === 'person-marcus')?.notes).toBe('Owns the player.'))
    })

    it('saves notes still waiting when the screen closes', async () => {
        const {router} = renderPerson('person-marcus')
        await userEvent.type(await screen.findByRole('textbox', {name: 'Private notes'}), 'Later')

        await router.navigate('/')

        await waitFor(() => expect(mockState.people.rows.find((person) => person.id === 'person-marcus')?.notes).toBe('Later'))
    })

    it('starts the notes from a save still on its way when the screen opens again', async () => {
        const original = handlers.api_update_person_notes
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        vi.spyOn(handlers, 'api_update_person_notes').mockImplementationOnce(async (args: MockArgs) => {
            await gate
            return original(args)
        })
        const {router} = renderPerson('person-marcus')
        await userEvent.type(await screen.findByRole('textbox', {name: 'Private notes'}), 'Later')
        await act(() => router.navigate('/'))

        await act(() => router.navigate('/person/person-marcus'))
        await screen.findByRole('heading', {level: 1, name: 'Marcus Lee'})
        // The cached profile still has the old notes: the field waits for the save.
        expect(screen.queryByRole('textbox', {name: 'Private notes'})).not.toBeInTheDocument()

        release()
        expect(await screen.findByRole('textbox', {name: 'Private notes'})).toHaveValue('Later')
    })

    it('saves notes typed just before a delete to the contact, not after it is gone', async () => {
        const {router} = renderPerson('person-sam')
        await userEvent.type(await screen.findByRole('textbox', {name: 'Private notes'}), 'Gone')
        await userEvent.click(screen.getByRole('button', {name: /More/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Delete contact…'}))
        await userEvent.click(within(screen.getByRole('dialog', {name: 'Delete Sam Rivera?'})).getByRole('button', {name: 'Delete contact'}))

        await waitFor(() => expect(router.state.location.pathname).toBe('/'))
        await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
        expect(screen.queryByText('Couldn’t save the notes')).not.toBeInTheDocument()
    })

    it('checks off an open action item, and Undo brings it back', async () => {
        await createActionItem('meeting-acme-review', {text: 'Send the support terms', ownerLabel: 'Priya Shah', audioTime: 30})
        renderPerson('person-priya')
        const items = await screen.findByRole('region', {name: 'Open action items'})
        const link = await within(items).findByRole('link', {name: /Send the support terms/})
        expect(link).toHaveAttribute('href', '/meetings/meeting-acme-review?tab=summary&at=30')

        await userEvent.click(within(items).getByRole('checkbox', {name: 'Mark “Send the support terms” as done'}))
        await waitFor(() => expect(within(items).queryByRole('link', {name: /Send the support terms/})).not.toBeInTheDocument())
        expect(await within(items).findByText('Nothing open for Priya.')).toBeInTheDocument()

        await userEvent.click(await screen.findByRole('button', {name: 'Undo'}))
        expect(await within(items).findByRole('link', {name: /Send the support terms/})).toBeInTheDocument()
    })

    it('learns a voice while Labs › Voice profiles is on', async () => {
        mockState.labs.voiceProfiles = true
        renderPerson('person-priya')
        const voice = await screen.findByRole('region', {name: 'Voice'})
        expect(voice).toHaveTextContent('Not learned yet')

        await userEvent.click(within(voice).getByRole('button', {name: 'Learn'}))

        expect(await within(voice).findByText(/^Learned from \d+ meetings$/)).toBeInTheDocument()
        expect(within(voice).getByRole('button', {name: 'Update'})).toBeInTheDocument()
    })

    it('keeps a learned voice forgettable after Labs is turned off', async () => {
        renderPerson('person-tom')
        const voice = await screen.findByRole('region', {name: 'Voice'})
        expect(voice).toHaveTextContent('isn’t used')
        expect(within(voice).queryByRole('button', {name: 'Update'})).not.toBeInTheDocument()

        await userEvent.click(within(voice).getByRole('button', {name: 'Forget'}))

        await waitFor(() => expect(screen.queryByRole('region', {name: 'Voice'})).not.toBeInTheDocument())
    })

    it('edits the details', async () => {
        renderPerson('person-marcus')
        await userEvent.click(await screen.findByRole('button', {name: 'Edit'}))
        const sheet = screen.getByRole('dialog', {name: 'Edit contact'})

        await userEvent.type(within(sheet).getByRole('textbox', {name: 'Phone'}), '+1 555 0100')
        await userEvent.click(within(sheet).getByRole('button', {name: 'Save'}))

        await waitFor(() => expect(screen.getByRole('region', {name: 'Details'})).toHaveTextContent('Phone+1 555 0100'))
    })

    it('merges into another contact and opens the one kept', async () => {
        const {router} = renderPerson('person-elena')
        await userEvent.click(await screen.findByRole('button', {name: /More/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Merge with another contact…'}))
        const sheet = screen.getByRole('dialog', {name: 'Merge Elena García'})

        await userEvent.click(within(sheet).getByRole('combobox', {name: 'Merge into'}))
        await userEvent.click(await screen.findByRole('option', {name: 'Marcus Lee'}))
        await userEvent.click(await within(sheet).findByRole('button', {name: 'Merge'}))

        await waitFor(() => expect(router.state.location.pathname).toBe('/person/person-marcus'))
        expect(await screen.findByRole('heading', {level: 1, name: 'Marcus Lee'})).toBeInTheDocument()
    })

    it('deletes the contact and goes home', async () => {
        const {router} = renderPerson('person-sam')
        await userEvent.click(await screen.findByRole('button', {name: /More/}))
        await userEvent.click(screen.getByRole('menuitem', {name: 'Delete contact…'}))

        await userEvent.click(within(screen.getByRole('dialog', {name: 'Delete Sam Rivera?'})).getByRole('button', {name: 'Delete contact'}))

        await waitFor(() => expect(router.state.location.pathname).toBe('/'))
        expect(mockState.people.rows.some((person) => person.id === 'person-sam')).toBe(false)
    })

    it('says when the contact is gone', async () => {
        renderPerson('person-gone')

        expect(await screen.findByRole('alert')).toHaveTextContent('This contact isn’t available')
        await userEvent.click(screen.getByRole('button', {name: 'Back to meetings'}))
        expect(await screen.findByRole('heading', {name: 'Home'})).toBeInTheDocument()
    })
})
