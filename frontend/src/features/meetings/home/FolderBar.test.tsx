import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {Folder} from '@/api/meetings'
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
})
