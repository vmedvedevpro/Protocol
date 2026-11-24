import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {RECORDING_AUDIO_LEVELS_EVENT} from '@/api/audio'
import {sampleFor} from '@/mocks/audio'
import {emitMockEvent} from '@/mocks/ipc'
import {settleIpc} from '@/test/ipc'
import {renderUi} from '@/test/renderUi'
import {inTheme} from '@/test/theme'
import {LevelMeter} from './LevelMeter'
import {SourceMeter} from './SourceMeter'

const MIC = {kind: 'recording', source: 'mic'} as const

describe('SourceMeter', () => {
    it('is a mute toggle that shows the level while on', async () => {
        const onToggle = vi.fn()
        renderUi(<SourceMeter source="mic" muted={false} level={MIC} onToggle={onToggle}/>)

        const button = screen.getByRole('button', {name: 'Mute microphone'})
        expect(button).toHaveAttribute('aria-pressed', 'false')
        expect(screen.queryByText('Muted')).not.toBeInTheDocument()

        await userEvent.click(button)
        expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it('says Muted, in its name too, and offers to turn the source back on when muted', async () => {
        renderUi(<SourceMeter source="system" muted level={null} onToggle={() => {}}/>)

        // The name holds the visible text (WCAG 2.5.3).
        const button = screen.getByRole('button', {name: 'Muted computer audio'})
        expect(button).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByText('Muted')).toBeVisible()

        await userEvent.tab()
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Turn on computer audio')
    })

    it('warns that computer audio is too loud, and says what to do', async () => {
        renderUi(<SourceMeter source="system" muted={false} level={null} warning="loud" onToggle={() => {}}/>)

        const button = screen.getByRole('button', {name: 'Mute computer audio, too loud'})
        expect(button).toHaveAttribute('aria-pressed', 'false')
        await userEvent.tab()
        expect(await screen.findByRole('tooltip')).toHaveTextContent(/Too loud: computer audio is being limited/)
    })

    it('leaves the warning out while muted', () => {
        renderUi(<SourceMeter source="system" muted level={null} warning="quiet" onToggle={() => {}}/>)
        expect(screen.getByRole('button', {name: 'Muted computer audio'})).toBeInTheDocument()
    })

    it('moves its bars with its own source only', async () => {
        renderUi(<SourceMeter source="mic" muted={false} level={MIC} onToggle={() => {}}/>)
        const bars = [...screen.getByRole('button').querySelectorAll<HTMLElement>('[aria-hidden="true"] > span')]
        expect(bars).toHaveLength(5)
        await settleIpc()

        await emitMockEvent(RECORDING_AUDIO_LEVELS_EVENT, {source: 'system', ...sampleFor(1), limiter_hit: false})
        expect(bars[0].style.transform).toBe('')

        await emitMockEvent(RECORDING_AUDIO_LEVELS_EVENT, {source: 'mic', ...sampleFor(1), limiter_hit: false})
        await waitFor(() => expect(bars[0].style.transform).toMatch(/^scaleY\(/))
        const scale = Number(/scaleY\((.*)\)/.exec(bars[0].style.transform)?.[1])
        expect(scale).toBeGreaterThan(0.4)
    })
})

describe('LevelMeter', () => {
    it('is named where it stands alone and hidden inside a named control', () => {
        const {rerender} = render(inTheme(<LevelMeter level={MIC} label="Microphone audio level"/>))
        expect(screen.getByRole('img', {name: 'Microphone audio level'})).toBeInTheDocument()

        rerender(inTheme(<LevelMeter level={MIC}/>))
        expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })
})
