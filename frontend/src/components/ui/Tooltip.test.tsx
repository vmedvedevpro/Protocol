import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {settleIpc} from '@/test/ipc'
import {playAnimations} from '@/test/motion'
import {renderUi} from '@/test/renderUi'
import {Tooltip} from './Tooltip'

const tipOf = (label: string) => screen.getByRole('tooltip', {name: label}).parentElement as HTMLElement

describe('Tooltip', () => {
    it('opens the first one with its entrance and the next in the row at once', async () => {
        await playAnimations()
        renderUi(
            <>
                <Tooltip content="Search"><button type="button">S</button></Tooltip>
                <Tooltip content="Settings"><button type="button">G</button></Tooltip>
            </>,
        )
        await settleIpc()

        await userEvent.hover(screen.getByRole('button', {name: 'S'}))
        await screen.findByRole('tooltip', {name: 'Search'}, {timeout: 2000})
        expect(Number(tipOf('Search').style.opacity)).toBeLessThan(1)

        // Within the skip window the next tooltip is there in the same frame.
        await userEvent.hover(screen.getByRole('button', {name: 'G'}))
        await screen.findByRole('tooltip', {name: 'Settings'})
        expect(tipOf('Settings')).toHaveAttribute('data-state', 'instant-open')
        expect(tipOf('Settings').style.opacity).toMatch(/^1?$/)
        await waitFor(() => expect(screen.queryByRole('tooltip', {name: 'Search'})).not.toBeInTheDocument())
    })
})
