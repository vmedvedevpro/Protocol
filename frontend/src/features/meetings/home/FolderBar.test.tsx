import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {Folder} from '@/api/meetings'
import {playAnimations, watchStyles} from '@/test/motion'
import {renderUi} from '@/test/renderUi'
import {FolderBar} from './FolderBar'

const CHIP_WIDTH = 80

const folder = (id: string, name: string): Folder => ({id, name, meetingCount: 2, createdAt: '2026-11-01T10:00:00Z'})
const FOLDERS = [folder('acme', 'Acme Corp'), folder('design', 'Design Team')]

function Bar() {
    const [selected, setSelected] = useState<string | null>(null)
    return <FolderBar folders={FOLDERS} selected={selected} onSelect={setSelected} onNew={() => {}} onRename={() => {}} onDelete={() => {}}/>
}

describe('FolderBar', () => {
    it('slides the selected chip’s thumb to the folder chosen', async () => {
        // jsdom lays nothing out: each chip stands CHIP_WIDTH further along, in order.
        vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
            const chips = Array.from(this.parentElement?.querySelectorAll('[aria-pressed]') ?? [])
            return Math.max(0, chips.indexOf(this)) * CHIP_WIDTH
        })
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(CHIP_WIDTH)
        renderUi(<Bar/>)
        const thumb = screen.getByTestId('folder-thumb')
        expect(thumb).toHaveStyle({width: `${CHIP_WIDTH}px`})

        await userEvent.click(screen.getByRole('button', {name: 'Design Team'}))

        expect(screen.getByRole('button', {name: 'Design Team'})).toHaveAttribute('aria-pressed', 'true')
        // The same element moved by transform: the outline slides, it does not jump to a new chip.
        await waitFor(() => expect(thumb.style.transform).toBe(`translateX(${2 * CHIP_WIDTH}px)`))
        expect(screen.getByTestId('folder-thumb')).toBe(thumb)
    })

    it('grows or shrinks the thumb to the chosen chip while it slides, not before', async () => {
        await playAnimations()
        // Chips of unequal widths, side by side: All 40 px, Acme Corp 80 px, Design Team 120 px.
        const widthOf = (element: HTMLElement) => {
            const chips = Array.from(element.parentElement?.querySelectorAll('[aria-pressed]') ?? [])
            return (Math.max(0, chips.indexOf(element)) + 1) * 40
        }
        vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
            return widthOf(this)
        })
        vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
            const chips = Array.from(this.parentElement?.querySelectorAll<HTMLElement>('[aria-pressed]') ?? [])
            return chips.slice(0, Math.max(0, chips.indexOf(this))).reduce((left, chip) => left + widthOf(chip), 0)
        })
        renderUi(<Bar/>)
        const thumb = screen.getByTestId('folder-thumb')
        expect(thumb).toHaveStyle({width: '40px'})

        const styles = watchStyles(thumb)
        await userEvent.click(screen.getByRole('button', {name: 'Design Team'}))
        await waitFor(() => expect(thumb).toHaveStyle({width: '120px'}), {timeout: 2000})

        // Every width on the way lies between the two chips', as the position does.
        const widths = styles.valuesOf(thumb, 'width').map(Number.parseFloat)
        expect(widths.length).toBeGreaterThan(2)
        expect(widths.slice(0, -1).every((width) => width > 40 && width < 120)).toBe(true)
    })

    it('holds the folder actions button’s place while All is selected', async () => {
        renderUi(<Bar/>)
        // The place after New folder; its size, and the row's height with
        // the button in it, are checked in Storybook (Meetings/FolderBar).
        const slot = screen.getByRole('button', {name: 'New folder'}).nextElementSibling
        expect(slot).not.toBeNull()
        expect(screen.queryByRole('button', {name: /^Folder actions/})).toBeNull()

        await userEvent.click(screen.getByRole('button', {name: 'Acme Corp'}))

        const actions = await screen.findByRole('button', {name: 'Folder actions: Acme Corp'})
        // The same node, now holding the button: nothing was added to the row.
        expect(screen.getByRole('button', {name: 'New folder'}).nextElementSibling).toBe(slot)
        expect(slot).toContainElement(actions)
    })
})
