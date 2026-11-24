import type {ReactNode} from 'react'
import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {ThemeProvider} from 'styled-components'
import {describe, expect, it, vi} from 'vitest'
import {RECORDING_AUDIO_LEVELS_EVENT} from '@/api/audio'
import {sampleFor} from '@/mocks/audio'
import {emitMockEvent} from '@/mocks/ipc'
import {lightTheme} from '@/styles/theme'
import {LevelMeter} from './LevelMeter'
import {SourceMeter} from './SourceMeter'

const inTheme = (node: ReactNode) => <ThemeProvider theme={lightTheme}>{node}</ThemeProvider>
const settleIpc = () => new Promise((resolve) => setTimeout(resolve, 0))
const MIC = {kind: 'recording', source: 'mic'} as const

describe('SourceMeter', () => {
    it('is a mute toggle that shows the level while on', async () => {
        const onToggle = vi.fn()
        render(inTheme(<SourceMeter source="mic" muted={false} level={MIC} onToggle={onToggle}/>))

        const button = screen.getByRole('button', {name: 'Mute microphone'})
        expect(button).toHaveAttribute('aria-pressed', 'false')
        expect(screen.queryByText('Muted')).not.toBeInTheDocument()

        await userEvent.click(button)
        expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it('says Muted and offers to turn the source back on when muted', () => {
        render(inTheme(<SourceMeter source="system" muted level={null} onToggle={() => {}}/>))

        const button = screen.getByRole('button', {name: 'Mute computer audio'})
        expect(button).toHaveAttribute('aria-pressed', 'true')
        expect(button).toHaveAttribute('title', 'Turn on computer audio')
        expect(screen.getByText('Muted')).toBeInTheDocument()
    })

    it('moves its bars with its own source only', async () => {
        render(inTheme(<SourceMeter source="mic" muted={false} level={MIC} onToggle={() => {}}/>))
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
