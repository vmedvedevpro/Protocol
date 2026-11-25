import {screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {DockedBar} from './DockedBar'

const ring = <canvas data-testid="ring"/>

describe('DockedBar', () => {
    it('brings a new phase in under a veil, but not the one it mounted in, keeping the bar and the ring mounted', () => {
        const {rerender} = renderUi(
            <DockedBar label="Record" ring={ring} action={<button type="button">Record</button>}>Ready to record</DockedBar>,
        )
        const bar = screen.getByRole('group', {name: 'Record'})
        const canvas = screen.getByTestId('ring')
        const idleBody = screen.getByText('Ready to record')
        // The phase it mounted in shows as it is: a screen that mounts the bar replays nothing.
        const record = screen.getByRole('button', {name: 'Record'})
        for (const content of [idleBody, record.parentElement as HTMLElement]) {
            expect(content.querySelector('[aria-hidden="true"]')).toBeNull()
        }

        // Starting keeps the label: the pending Record button stays where it is.
        rerender(<DockedBar label="Record" ring={ring} action={<button type="button">Record</button>}>Starting…</DockedBar>)
        expect(screen.getByText('Starting…')).toBe(idleBody)

        rerender(<DockedBar label="Recording" ring={ring} action={<button type="button">Stop</button>}>0:00</DockedBar>)
        expect(screen.getByRole('group', {name: 'Recording'})).toBe(bar)
        expect(screen.getByTestId('ring')).toBe(canvas)
        const body = screen.getByText('0:00')
        expect(body).not.toBe(idleBody)
        for (const content of [body, screen.getByRole('button', {name: 'Stop'}).parentElement as HTMLElement]) {
            expect(content.lastElementChild).toHaveAttribute('aria-hidden', 'true')
        }
    })
})
