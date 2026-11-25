import {act, fireEvent, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {MeetingPlayer, SLOW_PLAYBACK_RATES} from './player'
import {PlayerBar} from './PlayerBar'

/** A player whose recording has loaded: 10 minutes long. jsdom plays no audio, so play and pause are stubbed. */
function loadedPlayer() {
    const player = new MeetingPlayer()
    Object.defineProperty(player.audio, 'duration', {configurable: true, value: 600})
    vi.spyOn(player.audio, 'load').mockImplementation(() => {})
    let paused = true
    Object.defineProperty(player.audio, 'paused', {configurable: true, get: () => paused})
    vi.spyOn(player.audio, 'play').mockImplementation(() => {
        paused = false
        player.audio.dispatchEvent(new Event('play'))
        return Promise.resolve()
    })
    vi.spyOn(player.audio, 'pause').mockImplementation(() => {
        paused = true
        player.audio.dispatchEvent(new Event('pause'))
    })
    player.load('blob:recording')
    player.audio.dispatchEvent(new Event('loadedmetadata'))
    return player
}

function renderBar(player: MeetingPlayer) {
    const Bar = () => <PlayerBar player={player} {...player.getState()}/>
    const view = renderUi(<Bar/>)
    return {rerender: () => view.rerender(<Bar/>)}
}

describe('PlayerBar', () => {
    it('skips 5 s with the arrows while the scrubber has focus', async () => {
        const player = loadedPlayer()
        renderBar(player)
        player.seek(60)
        const scrubber = screen.getByRole('slider', {name: 'Playback position'})
        scrubber.focus()
        await userEvent.keyboard('{ArrowRight}')
        expect(player.position).toBe(65)
        await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
        expect(player.position).toBe(55)
        expect(scrubber).toHaveAttribute('aria-valuetext', '00:55 of 10:00')
    })

    it('plays and pauses with Space when no control has focus', async () => {
        const player = loadedPlayer()
        const {rerender} = renderBar(player)
        fireEvent.keyDown(document.body, {code: 'Space', key: ' '})
        rerender()
        expect(player.getState().playing).toBe(true)
        expect(screen.getByRole('button', {name: 'Pause'})).toBeInTheDocument()
        fireEvent.keyDown(document.body, {code: 'Space', key: ' '})
        expect(player.getState().playing).toBe(false)
    })

    it('steps through the speeds', async () => {
        const player = loadedPlayer()
        const {rerender} = renderBar(player)
        await userEvent.click(screen.getByRole('button', {name: 'Playback speed 1×'}))
        act(() => rerender())
        expect(screen.getByRole('button', {name: 'Playback speed 1.25×'})).toBeInTheDocument()
    })

    it('adds 0.5× and 0.75× with Labs › Waveform scrubbing', async () => {
        const player = loadedPlayer()
        player.audio.playbackRate = 2
        player.audio.dispatchEvent(new Event('ratechange'))
        const Bar = () => <PlayerBar player={player} {...player.getState()} rates={SLOW_PLAYBACK_RATES} peaks={[0.2, 0.8, 0.4]}/>
        const view = renderUi(<Bar/>)
        await userEvent.click(screen.getByRole('button', {name: 'Playback speed 2×'}))
        act(() => view.rerender(<Bar/>))
        expect(screen.getByRole('button', {name: 'Playback speed 0.5×'})).toBeInTheDocument()
        expect(screen.getByRole('slider', {name: 'Playback position'})).toBeEnabled()
    })

    it('says so when the meeting has no recording', () => {
        const player = new MeetingPlayer()
        player.load(null)
        renderBar(player)
        expect(screen.getByText('No audio was saved for this meeting.')).toBeInTheDocument()
        expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    })

    it('says where the recording was saved when that folder is gone', () => {
        const player = new MeetingPlayer()
        player.load(null)
        const folder = String.raw`C:\Users\User\Music\protocol-recordings\Standup_2025-10-02`
        renderUi(<PlayerBar player={player} {...player.getState()} missingFolder={folder}/>)
        expect(screen.getByText(`The recording isn’t where it was saved: ${folder}`)).toBeInTheDocument()
        expect(screen.queryByText('No audio was saved for this meeting.')).not.toBeInTheDocument()
    })
})
