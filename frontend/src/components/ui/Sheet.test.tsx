import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {MotionGlobalConfig} from 'motion/react'
import {describe, expect, it} from 'vitest'
import {settleIpc} from '@/test/ipc'
import {DotsThreeIcon} from '@phosphor-icons/react'
import {renderUi} from '@/test/renderUi'
import {Button, IconButton} from './Button'
import {Menu, MenuItem} from './Menu'
import {Sheet, SheetClose} from './Sheet'
import {TextField} from './TextField'

function ExportSheet({open, onOpenChange}: { open: boolean, onOpenChange: (open: boolean) => void }) {
    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title="Export"
            description="Save the meeting as a file or copy it."
            footer={<SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>}
        >
            <TextField label="File name" defaultValue="Acme pilot"/>
        </Sheet>
    )
}

function FromButton() {
    const [open, setOpen] = useState(false)
    return (
        <>
            <Button onClick={() => setOpen(true)}>Export</Button>
            <ExportSheet open={open} onOpenChange={setOpen}/>
        </>
    )
}

function FromMenu() {
    const [open, setOpen] = useState(false)
    return (
        <>
            <Menu trigger={<IconButton label="More actions" tooltip={false}><DotsThreeIcon/></IconButton>}>
                <MenuItem onSelect={() => setOpen(true)}>Export</MenuItem>
            </Menu>
            <ExportSheet open={open} onOpenChange={setOpen}/>
        </>
    )
}

const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

describe('Sheet', () => {
    it('opens as a named, described dialog and takes the focus', async () => {
        renderUi(<FromButton/>)

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))

        const dialog = await screen.findByRole('dialog', {name: 'Export'})
        expect(dialog).toHaveAccessibleDescription('Save the meeting as a file or copy it.')
        await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    })

    it('closes on Escape and gives the focus back to the button that opened it', async () => {
        renderUi(<FromButton/>)
        const opener = screen.getByRole('button', {name: 'Export'})

        await userEvent.click(opener)
        await screen.findByRole('dialog')
        await userEvent.keyboard('{Escape}')

        await closed()
        expect(opener).toHaveFocus()
    })

    it('closes from Cancel and the close button', async () => {
        renderUi(<FromButton/>)

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))
        await userEvent.click(await screen.findByRole('button', {name: 'Cancel'}))
        await closed()

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))
        await userEvent.click(await screen.findByRole('button', {name: 'Close'}))
        await closed()
    })

    it('gives the focus to the menu button when opened from a menu item that has gone', async () => {
        renderUi(<FromMenu/>)
        const menuButton = screen.getByRole('button', {name: 'More actions'})

        menuButton.focus()
        await userEvent.keyboard('{Enter}')
        await waitFor(() => expect(screen.getByRole('menuitem', {name: 'Export'})).toHaveFocus())
        await userEvent.keyboard('{Enter}')
        await screen.findByRole('dialog', {name: 'Export'})
        await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())

        await userEvent.keyboard('{Escape}')
        await closed()
        expect(menuButton).toHaveFocus()
    })

    it('opens and closes an instant sheet at once, with no spring and no scrim fade', async () => {
        // The motion runs here, so a sheet that animates is still there as it leaves.
        MotionGlobalConfig.skipAnimations = false
        await import('./motionFeatures')
        try {
            const sheet = (open: boolean, instant: boolean) => (
                <Sheet open={open} onOpenChange={() => {}} title="Search" bare instant={instant}><p>Rows</p></Sheet>
            )
            const {rerender} = renderUi(sheet(true, true))
            await settleIpc()
            const panel = screen.getByRole('dialog', {name: 'Search'})
            expect(panel.style.opacity).toBe('1')
            expect(panel.style.transform).toBe('none')

            rerender(sheet(false, true))
            expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

            rerender(sheet(true, false))
            rerender(sheet(false, false))
            expect(screen.getByText('Rows')).toBeInTheDocument()
        } finally {
            MotionGlobalConfig.skipAnimations = true
        }
    })
})
