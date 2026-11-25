import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {settleIpc} from '@/test/ipc'
import {playAnimations, watchStyles} from '@/test/motion'
import {renderUi} from '@/test/renderUi'
import {SegmentedControl, TabList, TabPanels, Tabs} from './SegmentedControl'

const RANGES = [
    {value: 'day', label: 'Day'},
    {value: 'week', label: 'Week'},
    {value: 'month', label: 'Month'},
] as const

type Range = (typeof RANGES)[number]['value']

function Ranges({onChange}: { onChange?: (value: Range) => void }) {
    const [value, setValue] = useState<Range>('day')
    return (
        <SegmentedControl
            label="Range"
            options={RANGES}
            value={value}
            onChange={(next) => {
                setValue(next)
                onChange?.(next)
            }}
        />
    )
}

// The radio itself is invisible to the pointer; a user clicks its label.
const option = (name: string) => screen.getByRole('radio', {name}).closest('label') as HTMLElement

const thumbOf = (group: HTMLElement) => group.querySelector(':scope > [aria-hidden]') as HTMLElement

/**
 * The transforms the thumb went through for one action: a key lands it at
 * once (one value), the pointer slides it (several).
 */
async function pathOf(thumb: HTMLElement, act: () => Promise<unknown>, to: RegExp) {
    const styles = watchStyles(thumb.parentElement as HTMLElement)
    await act()
    await waitFor(() => expect(styles.valuesOf(thumb, 'transform').at(-1)).toMatch(to), {timeout: 2000})
    styles.stop()
    return styles.valuesOf(thumb, 'transform')
}

describe('SegmentedControl', () => {
    it('is a radio group with the current value checked', () => {
        renderUi(<Ranges/>)

        expect(screen.getByRole('radio', {name: 'Day'})).toBeChecked()
        expect(screen.getAllByRole('radio')).toHaveLength(3)
    })

    it('reports a choice and moves the thumb onto it by transform', async () => {
        const onChange = vi.fn()
        renderUi(<Ranges onChange={onChange}/>)

        await userEvent.click(option('Month'))

        expect(onChange).toHaveBeenCalledWith('month')
        expect(screen.getByRole('radio', {name: 'Month'})).toBeChecked()
        // Segment 3 of equal segments: two thumb widths to the right. motion
        // writes the style on its next frame.
        const group = screen.getByRole('radiogroup', {name: 'Range'})
        await waitFor(() => expect(thumbOf(group).style.transform).toBe('translateX(200%)'))
    })

    it('moves between segments with the arrow keys', async () => {
        renderUi(<Ranges/>)

        await userEvent.tab()
        expect(screen.getByRole('radio', {name: 'Day'})).toHaveFocus()
        await userEvent.keyboard('{ArrowRight}')
        expect(screen.getByRole('radio', {name: 'Week'})).toBeChecked()
    })

    it('lands its thumb at once from the keyboard and slides it from the pointer', async () => {
        await playAnimations()
        renderUi(<Ranges/>)
        await settleIpc()
        const thumb = thumbOf(screen.getByRole('radiogroup', {name: 'Range'}))

        await userEvent.tab()
        expect(await pathOf(thumb, () => userEvent.keyboard('{ArrowRight}'), /^translateX\(100%\)$/)).toHaveLength(1)
        expect((await pathOf(thumb, () => userEvent.click(option('Month')), /^translateX\(200%\)$/)).length).toBeGreaterThan(2)
    })
})

const VIEWS = [
    {value: 'notes', label: 'Notes'},
    {value: 'transcript', label: 'Transcript'},
    {value: 'summary', label: 'Summary'},
] as const

type View = (typeof VIEWS)[number]['value']

function Meeting() {
    const [view, setView] = useState<View>('notes')
    return (
        <Tabs label="Meeting views" options={VIEWS} value={view} onChange={setView}>
            <TabList/>
            <TabPanels<View>>{(shown) => <p>{`${shown} view`}</p>}</TabPanels>
        </Tabs>
    )
}

describe('Tabs', () => {
    it('is a tab list whose selected tab labels the panel', () => {
        renderUi(<Meeting/>)

        expect(screen.getByRole('tablist', {name: 'Meeting views'})).toBeInTheDocument()
        const notes = screen.getByRole('tab', {name: 'Notes'})
        expect(notes).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('tabpanel', {name: 'Notes'})).toHaveTextContent('notes view')
        expect(notes).toHaveAttribute('aria-controls', screen.getByRole('tabpanel').id)
    })

    it('puts only the selected tab in the Tab order and moves with arrows, Home and End', async () => {
        renderUi(<Meeting/>)

        await userEvent.tab()
        expect(screen.getByRole('tab', {name: 'Notes'})).toHaveFocus()

        await userEvent.keyboard('{ArrowRight}')
        const transcript = screen.getByRole('tab', {name: 'Transcript'})
        expect(transcript).toHaveFocus()
        expect(transcript).toHaveAttribute('aria-selected', 'true')
        await waitFor(() => expect(screen.getByRole('tabpanel', {name: 'Transcript'})).toHaveTextContent('transcript view'))

        await userEvent.keyboard('{End}')
        expect(screen.getByRole('tab', {name: 'Summary'})).toHaveFocus()
        await userEvent.keyboard('{ArrowRight}')
        expect(screen.getByRole('tab', {name: 'Notes'})).toHaveFocus()
        await userEvent.keyboard('{ArrowLeft}{Home}')
        expect(screen.getByRole('tab', {name: 'Notes'})).toHaveFocus()

        // Tab leaves the list for the panel instead of walking the tabs.
        await userEvent.tab()
        expect(screen.getByRole('tabpanel', {name: 'Notes'})).toHaveFocus()
    })

    it('shows a clicked tab and fades the old panel out', async () => {
        renderUi(<Meeting/>)

        await userEvent.click(screen.getByRole('tab', {name: 'Summary'}))

        await waitFor(() => expect(screen.getAllByRole('tabpanel')).toHaveLength(1))
        expect(screen.getByRole('tabpanel', {name: 'Summary'})).toHaveTextContent('summary view')
    })

    it('lands its thumb at once from the keyboard and slides it from the pointer', async () => {
        await playAnimations()
        renderUi(<Meeting/>)
        await settleIpc()
        const thumb = thumbOf(screen.getByRole('tablist', {name: 'Meeting views'}))

        await userEvent.tab()
        expect(await pathOf(thumb, () => userEvent.keyboard('{End}'), /^translateX\(200%\)$/)).toHaveLength(1)
        const toNotes = () => userEvent.click(screen.getByRole('tab', {name: 'Notes'}))
        expect((await pathOf(thumb, toNotes, /^(none|translateX\(0(%|px)?\))$/)).length).toBeGreaterThan(2)
    })
})
