import {useState} from 'react'
import {fireEvent, screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {DotsThreeIcon} from '@phosphor-icons/react'
import {renderUi} from '@/test/renderUi'
import {IconButton} from './Button'
import {
    Menu,
    MenuCheckboxItem,
    MenuGroup,
    MenuItem,
    MenuRadioGroup,
    MenuRadioItem,
    MenuSeparator,
    MenuSub,
} from './Menu'

const ROW_HEIGHT = 28

function Actions({onExport = () => {}}: { onExport?: () => void }) {
    return (
        <Menu trigger={<IconButton label="More actions" tooltip={false}><DotsThreeIcon/></IconButton>}>
            <MenuItem onSelect={() => {}}>Rename</MenuItem>
            <MenuItem onSelect={() => {}}>Move to folder</MenuItem>
            <MenuSeparator/>
            <MenuItem onSelect={onExport}>Export</MenuItem>
        </Menu>
    )
}

const highlight = () => document.querySelector('[data-visible]') as HTMLElement

describe('Menu', () => {
    it('moves with the arrow keys, chooses with Enter and returns the focus', async () => {
        const onExport = vi.fn()
        renderUi(<Actions onExport={onExport}/>)
        const trigger = screen.getByRole('button', {name: 'More actions'})

        trigger.focus()
        await userEvent.keyboard('{Enter}')
        await screen.findByRole('menu')
        await waitFor(() => expect(screen.getByRole('menuitem', {name: 'Rename'})).toHaveFocus())

        await userEvent.keyboard('{ArrowDown}{ArrowDown}')
        expect(screen.getByRole('menuitem', {name: 'Export'})).toHaveFocus()
        await userEvent.keyboard('{Enter}')

        expect(onExport).toHaveBeenCalledOnce()
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
        expect(trigger).toHaveFocus()
    })

    it('checks one radio item and toggles a checkbox item', async () => {
        const onCheckedChange = vi.fn()
        function Inputs() {
            const [microphone, setMicrophone] = useState('headset')
            return (
                <Menu trigger={<IconButton label="Inputs" tooltip={false}><DotsThreeIcon/></IconButton>}>
                    <MenuGroup label="Microphone">
                        <MenuRadioGroup value={microphone} onValueChange={setMicrophone}>
                            <MenuRadioItem value="headset">Headset</MenuRadioItem>
                            <MenuRadioItem value="builtin">Built-in</MenuRadioItem>
                        </MenuRadioGroup>
                    </MenuGroup>
                    <MenuCheckboxItem checked={false} onCheckedChange={onCheckedChange}>Record all apps</MenuCheckboxItem>
                </Menu>
            )
        }
        renderUi(<Inputs/>)

        await userEvent.click(screen.getByRole('button', {name: 'Inputs'}))
        expect(screen.getByRole('group', {name: 'Microphone'})).toBeInTheDocument()
        expect(screen.getByRole('menuitemradio', {name: 'Headset'})).toBeChecked()
        await userEvent.click(screen.getByRole('menuitemradio', {name: 'Built-in'}))

        await userEvent.click(screen.getByRole('button', {name: 'Inputs'}))
        expect(await screen.findByRole('menuitemradio', {name: 'Built-in'})).toBeChecked()
        await userEvent.click(screen.getByRole('menuitemcheckbox', {name: 'Record all apps'}))
        expect(onCheckedChange).toHaveBeenCalledWith(true)
    })

    it('opens a submenu with the right arrow and goes back with the left', async () => {
        const onMove = vi.fn()
        renderUi(
            <Menu trigger={<IconButton label="More actions" tooltip={false}><DotsThreeIcon/></IconButton>}>
                <MenuSub label="Move to folder">
                    <MenuItem onSelect={() => onMove('acme')}>Acme Corp</MenuItem>
                    <MenuItem onSelect={() => onMove('hiring')}>Hiring</MenuItem>
                </MenuSub>
            </Menu>,
        )

        screen.getByRole('button', {name: 'More actions'}).focus()
        await userEvent.keyboard('{Enter}')
        const sub = await screen.findByRole('menuitem', {name: 'Move to folder'})
        await waitFor(() => expect(sub).toHaveFocus())

        await userEvent.keyboard('{ArrowRight}')
        await waitFor(() => expect(screen.getByRole('menuitem', {name: 'Acme Corp'})).toHaveFocus())
        await userEvent.keyboard('{ArrowLeft}')
        await waitFor(() => expect(sub).toHaveFocus())

        await userEvent.keyboard('{ArrowRight}')
        await waitFor(() => expect(screen.getByRole('menuitem', {name: 'Acme Corp'})).toHaveFocus())
        await userEvent.keyboard('{ArrowDown}{Enter}')
        expect(onMove).toHaveBeenCalledWith('hiring')
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    })

    it('keeps the highlight on the last item while the pointer crosses a divider, then lands past it', async () => {
        // jsdom lays nothing out: give each row of the menu its place by order.
        vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
            const siblings = this.parentElement ? Array.from(this.parentElement.children) : []
            return siblings.indexOf(this) * ROW_HEIGHT
        })
        renderUi(<Actions/>)
        // One pointer for the whole walk, so moving on leaves the last element.
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'More actions'}))
        const moveTo = await screen.findByRole('menuitem', {name: 'Move to folder'})
        await user.hover(screen.getByRole('menuitem', {name: 'Rename'}))
        await user.hover(moveTo)
        await waitFor(() => expect(highlight().style.transform).toBe(`translateY(${2 * ROW_HEIGHT}px)`))
        expect(highlight()).toHaveAttribute('data-visible', 'true')
        // Between neighbours it slides.
        expect(highlight()).toHaveAttribute('data-move', 'slide')

        // Off the item onto the divider: Radix un-highlights the item, the
        // highlight stays where it was.
        await user.hover(screen.getByRole('separator'))
        expect(moveTo).not.toHaveFocus()
        expect(highlight()).toHaveAttribute('data-visible', 'true')
        expect(highlight().style.transform).toBe(`translateY(${2 * ROW_HEIGHT}px)`)

        // Onto the next item: it lands there rather than sliding across the divider.
        await user.hover(screen.getByRole('menuitem', {name: 'Export'}))
        await waitFor(() => expect(highlight().style.transform).toBe(`translateY(${4 * ROW_HEIGHT}px)`))
        expect(highlight()).toHaveAttribute('data-move', 'land')

        // Out of the menu (user-event cannot point outside an open menu,
        // which blocks pointer events there): it fades.
        fireEvent.pointerLeave(screen.getByRole('menu'))
        expect(highlight()).toHaveAttribute('data-visible', 'false')
    })

    it('lands rather than slides from one group to the next, never crossing a group label', async () => {
        renderUi(
            <Menu trigger={<IconButton label="Inputs" tooltip={false}><DotsThreeIcon/></IconButton>}>
                <MenuGroup label="Microphone">
                    <MenuItem onSelect={() => {}}>Headset</MenuItem>
                </MenuGroup>
                <MenuGroup label="Computer audio">
                    <MenuItem onSelect={() => {}}>Speakers</MenuItem>
                    <MenuItem onSelect={() => {}}>Display</MenuItem>
                </MenuGroup>
            </Menu>,
        )
        const user = userEvent.setup()
        await user.click(screen.getByRole('button', {name: 'Inputs'}))

        await user.hover(await screen.findByRole('menuitem', {name: 'Headset'}))
        await user.hover(screen.getByText('Computer audio'))
        await user.hover(screen.getByRole('menuitem', {name: 'Speakers'}))
        await waitFor(() => expect(screen.getByRole('menuitem', {name: 'Speakers'})).toHaveFocus())
        expect(highlight()).toHaveAttribute('data-move', 'land')

        await user.hover(screen.getByRole('menuitem', {name: 'Display'}))
        await waitFor(() => expect(screen.getByRole('menuitem', {name: 'Display'})).toHaveFocus())
        expect(highlight()).toHaveAttribute('data-move', 'slide')
    })

    it('draws its shadow on a surface that does not scroll; the rows scroll inside', async () => {
        renderUi(<Actions/>)
        await userEvent.click(screen.getByRole('button', {name: 'More actions'}))
        const menu = await screen.findByRole('menu')
        expect(getComputedStyle(menu).overflowY).not.toBe('auto')
        expect(getComputedStyle(menu.firstElementChild!).overflowY).toBe('auto')
    })

    it('hides the highlight over a disabled item, where Enter would do nothing', async () => {
        renderUi(
            <Menu trigger={<IconButton label="More actions" tooltip={false}><DotsThreeIcon/></IconButton>}>
                <MenuItem onSelect={() => {}}>Export</MenuItem>
                <MenuItem onSelect={() => {}} disabled>Delete while processing</MenuItem>
            </Menu>,
        )
        const user = userEvent.setup()

        await user.click(screen.getByRole('button', {name: 'More actions'}))
        await user.hover(await screen.findByRole('menuitem', {name: 'Export'}))
        await waitFor(() => expect(highlight()).toHaveAttribute('data-visible', 'true'))

        await user.hover(screen.getByRole('menuitem', {name: 'Delete while processing'}))
        expect(highlight()).toHaveAttribute('data-visible', 'false')
    })
})
