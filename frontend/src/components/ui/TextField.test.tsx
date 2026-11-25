import {useState} from 'react'
import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import {renderUi} from '@/test/renderUi'
import {Kbd} from './Kbd'
import {SettingsRow} from './SettingsRow'
import {TextArea, TextField} from './TextField'

describe('TextField', () => {
    it('is named by its label, described by its hint and typed into as a controlled value', async () => {
        function Name() {
            const [name, setName] = useState('')
            return (
                <TextField
                    label="What should we call you?"
                    hint="Shown instead of “You” in transcripts."
                    value={name}
                    onChange={(event) => setName(event.target.value.toUpperCase())}
                />
            )
        }
        renderUi(<Name/>)

        const field = screen.getByRole('textbox', {name: 'What should we call you?'})
        expect(field).toHaveAccessibleDescription('Shown instead of “You” in transcripts.')
        await userEvent.type(field, 'tyler')
        expect(field).toHaveValue('TYLER')
    })

    it('keeps its icon and hint out of its name', async () => {
        renderUi(
            <TextField
                type="search"
                aria-label="Search meetings"
                icon={<MagnifyingGlassIcon aria-hidden/>}
                trailing={<Kbd>Ctrl K</Kbd>}
            />,
        )

        const field = screen.getByRole('searchbox', {name: 'Search meetings'})
        await userEvent.click(field)
        expect(field).toHaveFocus()
    })
})

describe('TextArea', () => {
    it('takes several lines', async () => {
        renderUi(<TextArea label="Words to recognize"/>)

        const area = screen.getByRole('textbox', {name: 'Words to recognize'})
        await userEvent.type(area, 'Acme{Enter}Parakeet')
        expect(area).toHaveValue('Acme\nParakeet')
    })

    it('keeps its own aria-label inside a SettingsRow, where an unnamed field takes the row\'s', () => {
        renderUi(
            <SettingsRow label="Custom vocabulary" control={<TextField size="sm" defaultValue="Acme"/>}>
                <TextArea aria-label="Words to recognize"/>
            </SettingsRow>,
        )

        expect(screen.getByRole('textbox', {name: 'Custom vocabulary'})).toHaveValue('Acme')
        expect(screen.getByRole('textbox', {name: 'Words to recognize'})).toBeInTheDocument()
    })
})
