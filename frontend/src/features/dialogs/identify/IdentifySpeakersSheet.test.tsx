import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {mockState} from '@/mocks/state'
import {renderDialogs} from '../testing/renderDialogs'

const NAME = 'Identify speakers'

async function open() {
    const identify = vi.fn()
    renderDialogs({kind: 'identify-speakers', identify})
    const dialog = await screen.findByRole('dialog', {name: NAME})
    return {dialog, identify}
}

/** Picks a count; the sheet is hidden from the accessibility tree until the list has gone. */
async function pick(dialog: HTMLElement, option: string) {
    await userEvent.click(within(dialog).getByRole('combobox', {name: 'Speakers'}))
    await userEvent.click(await screen.findByRole('option', {name: option}))
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
}

const closed = () => waitFor(() => expect(screen.queryByRole('dialog', {name: NAME})).not.toBeInTheDocument())

describe('IdentifySpeakersSheet', () => {
    it('starts on Detect automatically and runs with no count', async () => {
        const {dialog, identify} = await open()
        expect(within(dialog).getByRole('combobox', {name: 'Speakers'})).toHaveTextContent('Detect automatically')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Identify'}))
        expect(identify).toHaveBeenCalledExactlyOnceWith(null)
        await closed()
    })

    it('waits for Identify before running with the count picked', async () => {
        const {dialog, identify} = await open()
        await pick(dialog, '4 speakers')
        expect(identify).not.toHaveBeenCalled()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Identify'}))
        expect(identify).toHaveBeenCalledExactlyOnceWith(4)
        await closed()
    })

    it('starts nothing on Cancel', async () => {
        const {dialog, identify} = await open()
        await pick(dialog, '3 speakers')
        await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}))
        await closed()
        expect(identify).not.toHaveBeenCalled()
    })

    it('offers no count with Nemotron, which finds the number itself', async () => {
        mockState.diarization.engine = 'nemotron'
        mockState.diarization.nemotronInstalled = true
        const {dialog, identify} = await open()
        expect(await within(dialog).findByText(/finds the number of speakers itself/)).toBeInTheDocument()
        expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Identify'}))
        expect(identify).toHaveBeenCalledExactlyOnceWith(null)
        await closed()
    })
})
