import {screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {ProgressBar} from './ProgressBar'
import {renderUi} from './renderUi'

describe('ProgressBar', () => {
    it('reports its value and scales its fill to it', () => {
        renderUi(<ProgressBar label="Downloading Parakeet" value={40}/>)

        const bar = screen.getByRole('progressbar', {name: 'Downloading Parakeet'})
        expect(bar).toHaveAttribute('aria-valuenow', '40')
        expect((bar.firstElementChild as HTMLElement).style.transform).toBe('scaleX(0.4)')
    })

    it('keeps a stray value inside its range', () => {
        renderUi(<ProgressBar label="Downloading" value={130}/>)

        expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    })
})
