import {useState} from 'react'
import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {GearSixIcon, PushPinIcon} from '@phosphor-icons/react'
import {renderUi} from '@/test/renderUi'
import {Button, IconButton} from './Button'

describe('Button', () => {
    it('is a plain button that reports clicks and Enter', async () => {
        const onClick = vi.fn()
        renderUi(<Button onClick={onClick}>Export</Button>)

        const button = screen.getByRole('button', {name: 'Export'})
        expect(button).toHaveAttribute('type', 'button')
        await userEvent.click(button)
        await userEvent.keyboard('{Enter}')
        expect(onClick).toHaveBeenCalledTimes(2)
    })

    it('ignores a disabled click', async () => {
        const onClick = vi.fn()
        renderUi(<Button onClick={onClick} disabled>Export</Button>)

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))
        expect(onClick).not.toHaveBeenCalled()
    })
})

describe('IconButton', () => {
    it('is named by its label and shows it with the shortcut on keyboard focus', async () => {
        renderUi(<IconButton label="Settings" shortcut="Ctrl ,"><GearSixIcon/></IconButton>)

        await userEvent.tab()
        expect(screen.getByRole('button', {name: 'Settings'})).toHaveFocus()
        expect(await screen.findByRole('tooltip')).toHaveTextContent('Settings (Ctrl ,)')
    })

    it('says whether a toggle is on', async () => {
        function Pin() {
            const [on, setOn] = useState(false)
            return <IconButton label="Keep on top" pressed={on} onClick={() => setOn(!on)}><PushPinIcon/></IconButton>
        }
        renderUi(<Pin/>)

        const pin = screen.getByRole('button', {name: 'Keep on top'})
        expect(pin).toHaveAttribute('aria-pressed', 'false')
        await userEvent.click(pin)
        expect(pin).toHaveAttribute('aria-pressed', 'true')
    })
})
