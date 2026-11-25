import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {settleIpc} from '@/test/ipc'
import {playAnimations, watchStyles} from '@/test/motion'
import {renderUi} from '@/test/renderUi'
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

// At 0 motion writes no translation.
const RESTING = /^(none|translateX\(0(%|px)?\))$/

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

    it('lands its knob at once from the keyboard and springs it from the pointer', async () => {
        await playAnimations()
        renderUi(<Controlled/>)
        await settleIpc()
        const toggle = screen.getByRole('switch', {name: 'Save audio'})
        const knob = toggle.firstElementChild as HTMLElement

        const byKey = watchStyles(toggle)
        toggle.focus()
        await userEvent.keyboard(' ')
        await waitFor(() => expect(knob.style.transform).toBe('translateX(100%)'))
        // Straight to its place: no step in between.
        expect(byKey.valuesOf(knob, 'transform')).toEqual(['translateX(100%)'])

        const byPointer = watchStyles(toggle)
        await userEvent.click(toggle)
        expect(toggle).not.toBeChecked()
        await waitFor(() => expect(byPointer.valuesOf(knob, 'transform').at(-1)).toMatch(RESTING), {timeout: 2000})
        expect(byPointer.valuesOf(knob, 'transform').length).toBeGreaterThan(2)
    })
})
