import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {Button} from './Button'
import {renderUi} from './renderUi'
import {Sheet, SheetClose} from './Sheet'
import {TextField} from './TextField'

function Export({withTrigger = true}: { withTrigger?: boolean }) {
    const [open, setOpen] = useState(false)
    return (
        <>
            {!withTrigger && <Button onClick={() => setOpen(true)}>Open from elsewhere</Button>}
            <Sheet
                open={open}
                onOpenChange={setOpen}
                trigger={withTrigger ? <Button>Export</Button> : undefined}
                title="Export"
                description="Save the meeting as a file or copy it."
                footer={<SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>}
            >
                <TextField label="File name" defaultValue="Acme pilot"/>
            </Sheet>
        </>
    )
}

describe('Sheet', () => {
    it('opens as a named, described dialog and takes the focus', async () => {
        renderUi(<Export/>)

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))

        const dialog = await screen.findByRole('dialog', {name: 'Export'})
        expect(dialog).toHaveAccessibleDescription('Save the meeting as a file or copy it.')
        await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    })

    it('closes on Escape and gives the focus back to its trigger', async () => {
        renderUi(<Export/>)
        const trigger = screen.getByRole('button', {name: 'Export'})

        await userEvent.click(trigger)
        await screen.findByRole('dialog')
        await userEvent.keyboard('{Escape}')

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(trigger).toHaveFocus()
    })

    it('closes from Cancel and the close button', async () => {
        renderUi(<Export/>)

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))
        await userEvent.click(await screen.findByRole('button', {name: 'Cancel'}))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

        await userEvent.click(screen.getByRole('button', {name: 'Export'}))
        await userEvent.click(await screen.findByRole('button', {name: 'Close'}))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })

    it('gives the focus back to what had it when opened without a trigger', async () => {
        renderUi(<Export withTrigger={false}/>)
        const opener = screen.getByRole('button', {name: 'Open from elsewhere'})

        await userEvent.click(opener)
        await screen.findByRole('dialog')
        await userEvent.keyboard('{Escape}')

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
        expect(opener).toHaveFocus()
    })
})
