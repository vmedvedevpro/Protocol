import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {renderDialogs} from '../testing/renderDialogs'

const NAME = 'Identify speakers'

async function open() {
    const identify = vi.fn()
    renderDialogs({kind: 'identify-speakers', identify})
    const dialog = await screen.findByRole('dialog', {name: NAME})
    return {dialog, identify}
}

const closed = () => waitFor(() => expect(screen.queryByRole('dialog', {name: NAME})).not.toBeInTheDocument())

describe('IdentifySpeakersSheet', () => {
    it('starts on Detect automatically and runs with no count', async () => {
        const {dialog, identify} = await open()
        expect(within(dialog).getByRole('radio', {name: 'Detect automatically'})).toBeChecked()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Identify'}))
        expect(identify).toHaveBeenCalledExactlyOnceWith(null)
        await closed()
    })

    it('waits for Identify before running with the count picked', async () => {
        const {dialog, identify} = await open()
        await userEvent.click(within(dialog).getByRole('radio', {name: '4 speakers'}))
        expect(identify).not.toHaveBeenCalled()
        await userEvent.click(within(dialog).getByRole('button', {name: 'Identify'}))
        expect(identify).toHaveBeenCalledExactlyOnceWith(4)
        await closed()
    })

    it('starts nothing on Cancel', async () => {
        const {dialog, identify} = await open()
        await userEvent.click(within(dialog).getByRole('radio', {name: '3 speakers'}))
        await userEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}))
        await closed()
        expect(identify).not.toHaveBeenCalled()
    })
})
