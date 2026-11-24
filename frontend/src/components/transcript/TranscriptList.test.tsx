import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {type PlaybackClock, TranscriptList} from './TranscriptList'
import type {TranscriptLine} from './turns'

const LINES: TranscriptLine[] = [
    {id: 'a', text: 'Thanks for making time.', start: 4, end: 9, speaker: 'You'},
    {id: 'b', text: 'Where does the audio end up?', start: 198, end: 204, speaker: 'Speaker 2'},
    {id: 'c', text: 'Nothing leaves the laptop.', start: 393, end: 399, speaker: 'You'},
    {id: 'd', text: 'Can we disable cloud providers?', start: 588, end: 592, speaker: 'Speaker 2 + Priya Shah'},
]

/** A clock the test moves by hand. */
function manualClock() {
    const listeners = new Set<(seconds: number) => void>()
    const clock: PlaybackClock = {
        subscribe: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
    }
    return {clock, tick: (seconds: number) => act(() => listeners.forEach((listener) => listener(seconds)))}
}

const row = (text: string) => screen.getByText(text).closest('li')!

describe('TranscriptList', () => {
    it('shows each turn with its time and voice, and plays from a time', async () => {
        const onSeek = vi.fn()
        renderUi(<TranscriptList label="Transcript" lines={LINES} onSeek={onSeek} userName="Jay"/>)

        expect(screen.getByRole('region', {name: 'Transcript'})).toBeInTheDocument()
        expect(screen.getAllByRole('listitem')).toHaveLength(4)
        expect(screen.getAllByText('Jay (You)')).toHaveLength(2)

        await userEvent.click(screen.getByRole('button', {name: 'Play from 06:33'}))

        expect(onSeek).toHaveBeenCalledWith(393)
    })

    it('shows times as text when nothing plays them', () => {
        renderUi(<TranscriptList label="Transcript" lines={LINES}/>)

        expect(screen.getByText('03:18')).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: /Play from/})).not.toBeInTheDocument()
    })

    it('names a voice in place, on Enter, and goes back to its button', async () => {
        const onRename = vi.fn().mockResolvedValue(undefined)
        renderUi(<TranscriptList label="Transcript" lines={LINES} onRenameSpeaker={onRename}/>)

        // The user's own voice and an overlap are not named here.
        expect(screen.getAllByRole('button', {name: /^Name /})).toHaveLength(1)
        await userEvent.click(screen.getByRole('button', {name: 'Name Speaker 2'}))
        await userEvent.type(screen.getByRole('textbox', {name: 'Name Speaker 2'}), 'Tom Becker{Enter}')

        expect(onRename).toHaveBeenCalledWith('Speaker 2', 'Tom Becker')
        await waitFor(() => expect(screen.getByRole('button', {name: 'Name Speaker 2'})).toHaveFocus())
    })

    it('keeps the field open when the rename fails, and leaves it on Escape without renaming', async () => {
        const onRename = vi.fn().mockRejectedValue(new Error('Failed to rename speaker'))
        renderUi(<TranscriptList label="Transcript" lines={LINES} onRenameSpeaker={onRename}/>)

        await userEvent.click(screen.getByRole('button', {name: 'Name Speaker 2'}))
        await userEvent.type(screen.getByRole('textbox', {name: 'Name Speaker 2'}), 'Tom{Enter}')
        expect(screen.getByRole('textbox', {name: 'Name Speaker 2'})).toBeInTheDocument()

        await userEvent.keyboard('{Escape}')
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
        expect(onRename).toHaveBeenCalledTimes(1)
    })

    it('marks the turn being played without rendering the rows again', () => {
        const {clock, tick} = manualClock()
        renderUi(<TranscriptList label="Transcript" lines={LINES} playback={clock}/>)

        tick(200)
        expect(row('Where does the audio end up?')).toHaveAttribute('aria-current', 'true')

        tick(400)
        expect(row('Where does the audio end up?')).not.toHaveAttribute('aria-current')
        expect(row('Nothing leaves the laptop.')).toHaveAttribute('data-active')
    })

    it('shows the empty state while there are no lines', () => {
        renderUi(<TranscriptList label="Transcript" lines={[]} empty={<p>No transcript yet</p>}/>)

        // Within the region: the window's toasts are a list too.
        const region = screen.getByRole('region', {name: 'Transcript'})
        expect(within(region).getByText('No transcript yet')).toBeInTheDocument()
        expect(within(region).queryByRole('list')).not.toBeInTheDocument()
    })

    it('follows the end of a live transcript until the user scrolls up', () => {
        const {rerender} = renderUi(<TranscriptList label="Live transcript" live lines={LINES.slice(0, 2)}/>)
        const region = screen.getByRole('region', {name: 'Live transcript'})
        // jsdom lays nothing out: give the box a size the test controls.
        let scrollHeight = 1000
        Object.defineProperty(region, 'scrollHeight', {get: () => scrollHeight})
        Object.defineProperty(region, 'clientHeight', {get: () => 300})

        scrollHeight = 1200
        rerender(<TranscriptList label="Live transcript" live lines={LINES.slice(0, 3)}/>)
        expect(region.scrollTop).toBe(1200)

        // Scrolled up: new lines no longer pull the view down, and Latest offers the way back.
        act(() => {
            region.scrollTop = 200
            region.dispatchEvent(new Event('scroll'))
        })
        scrollHeight = 1400
        rerender(<TranscriptList label="Live transcript" live lines={LINES}/>)
        expect(region.scrollTop).toBe(200)
        expect(screen.getByRole('button', {name: 'Latest'})).toBeInTheDocument()
    })

    it('keeps every row in place when a live list stops being live', () => {
        const {rerender} = renderUi(<TranscriptList label="Transcript" live lines={LINES.slice(0, 2)}/>)
        rerender(<TranscriptList label="Transcript" live lines={LINES}/>)
        const arrived = row('Nothing leaves the laptop.')
        const first = row('Thanks for making time.')

        rerender(<TranscriptList label="Transcript" lines={LINES}/>)

        expect(row('Nothing leaves the laptop.')).toBe(arrived)
        expect(row('Thanks for making time.')).toBe(first)
    })

    it('calls the latest callbacks and cleans the text it shows', async () => {
        const first = vi.fn()
        const latest = vi.fn()
        const clean = (text: string) => text.replace('Thanks for making time.', 'Thanks for the time.')
        const {rerender} = renderUi(<TranscriptList label="Transcript" lines={LINES} onSeek={first} clean={clean}/>)
        rerender(<TranscriptList label="Transcript" lines={LINES} onSeek={latest} clean={clean}/>)

        await userEvent.click(screen.getByRole('button', {name: 'Play from 00:04'}))

        expect(first).not.toHaveBeenCalled()
        expect(latest).toHaveBeenCalledWith(4)
        expect(screen.getByText('Thanks for the time.')).toBeInTheDocument()
    })
})
