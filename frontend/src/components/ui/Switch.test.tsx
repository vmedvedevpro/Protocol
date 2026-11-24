import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {renderUi} from './renderUi'
import {Switch} from './Switch'

function Controlled({onChange}: { onChange?: (checked: boolean) => void }) {
    const [checked, setChecked] = useState(false)
    return (
        <Switch
            label="Save audio"
            checked={checked}
            onCheckedChange={(next) => {
                setChecked(next)
                onChange?.(next)
            }}
        />
    )
}

describe('Switch', () => {
    it('toggles from a click and from Space, and springs its knob across', async () => {
        const onChange = vi.fn()
        renderUi(<Controlled onChange={onChange}/>)

        const toggle = screen.getByRole('switch', {name: 'Save audio'})
        expect(toggle).not.toBeChecked()

        await userEvent.click(toggle)
        expect(toggle).toBeChecked()
        await waitFor(() => expect((toggle.firstElementChild as HTMLElement).style.transform).toBe('translateX(100%)'))

        await userEvent.keyboard(' ')
        expect(toggle).not.toBeChecked()
        expect(onChange.mock.calls).toEqual([[true], [false]])
    })

    it('stays as its owner holds it', async () => {
        const onChange = vi.fn()
        renderUi(<Switch label="Save audio" checked={false} onCheckedChange={onChange}/>)

        await userEvent.click(screen.getByRole('switch', {name: 'Save audio'}))
        expect(onChange).toHaveBeenCalledWith(true)
        expect(screen.getByRole('switch', {name: 'Save audio'})).not.toBeChecked()
    })
})
