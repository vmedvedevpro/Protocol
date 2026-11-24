import {useState} from 'react'
import {render, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {ThemeProvider} from 'styled-components'
import {MotionProvider} from '@/app/MotionProvider'
import {lightTheme} from '@/styles/theme'
import {SegmentedControl} from './SegmentedControl'

const RANGES = [
    {value: 'day', label: 'Day'},
    {value: 'week', label: 'Week'},
    {value: 'month', label: 'Month'},
] as const

type Range = (typeof RANGES)[number]['value']

function Ranges({onChange}: { onChange?: (value: Range) => void }) {
    const [value, setValue] = useState<Range>('day')
    return (
        <ThemeProvider theme={lightTheme}>
            <MotionProvider>
                <SegmentedControl
                    label="Range"
                    options={RANGES}
                    value={value}
                    onChange={(next) => {
                        setValue(next)
                        onChange?.(next)
                    }}
                />
            </MotionProvider>
        </ThemeProvider>
    )
}

// The radio itself is invisible to the pointer; a user clicks its label.
const option = (name: string) => screen.getByRole('radio', {name}).closest('label') as HTMLElement

const thumb = () => screen.getByRole('radiogroup', {name: 'Range'}).querySelector(':scope > [aria-hidden]') as HTMLElement

describe('SegmentedControl', () => {
    it('is a radio group with the current value checked', () => {
        render(<Ranges/>)

        expect(screen.getByRole('radio', {name: 'Day'})).toBeChecked()
        expect(screen.getAllByRole('radio')).toHaveLength(3)
    })

    it('reports a choice and moves the thumb onto it by transform', async () => {
        const onChange = vi.fn()
        render(<Ranges onChange={onChange}/>)

        await userEvent.click(option('Month'))

        expect(onChange).toHaveBeenCalledWith('month')
        expect(screen.getByRole('radio', {name: 'Month'})).toBeChecked()
        // Segment 3 of equal segments: two thumb widths to the right. motion
        // writes the style on its next frame.
        await waitFor(() => expect(thumb().style.transform).toBe('translateX(200%)'))
    })
})
