import {createElement} from 'react'
import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {TranscriptSegment} from '@/api/meetings'
import {renderUi} from '@/test/renderUi'
import {SpeakerCount} from './SpeakerCount'

const lines: TranscriptSegment[] = Array.from({length: 12}, (_, index) => ({
    id: `line-${index}`,
    text: 'Hello.',
    timestamp: '14:30:05',
    speaker: `Speaker ${index + 1}`,
}))

describe('SpeakerCount', () => {
    it('keeps the count as text and the button’s name on an icon-only button', async () => {
        const onIdentify = vi.fn()
        renderUi(createElement(SpeakerCount, {lines, onIdentify, running: false}))

        expect(screen.getByText('12 speakers')).toBeInTheDocument()
        const button = screen.getByRole('button', {name: 'Identify speakers…'})
        expect(button).toHaveTextContent('')
        await userEvent.click(button)
        expect(onIdentify).toHaveBeenCalledOnce()
    })

    it('waits while a run goes, under the same name', () => {
        renderUi(createElement(SpeakerCount, {lines, onIdentify: vi.fn(), running: true}))

        const button = screen.getByRole('button', {name: 'Identify speakers…'})
        expect(button).toBeDisabled()
        expect(button).toHaveAttribute('aria-busy', 'true')
    })
})
