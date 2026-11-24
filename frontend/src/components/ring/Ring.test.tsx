import {render, screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {inTheme} from '@/test/theme'
import {Ring} from './Ring'

describe('Ring', () => {
    // jsdom has no WebGL, so these render the static ring.
    it('shows the static ring without WebGL, hidden from assistive technology', () => {
        const {container} = render(inTheme(<Ring mode="rec" size={48}/>))

        expect(screen.getByTestId('static-ring')).toBeInTheDocument()
        expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true')
        expect(container.firstElementChild).toHaveStyle({'--ring-size': '48px'})
    })

    it('greys the static ring as the shader does for each mode', () => {
        const {rerender} = render(inTheme(<Ring mode="rec" size={48}/>))
        expect(screen.getByTestId('static-ring')).toHaveStyle({filter: 'grayscale(0)', opacity: '1'})

        rerender(inTheme(<Ring mode="paused" size={48}/>))
        expect(screen.getByTestId('static-ring')).toHaveStyle({filter: 'grayscale(1)', opacity: '0.65'})
    })
})
