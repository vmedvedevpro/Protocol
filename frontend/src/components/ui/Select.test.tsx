import {useState} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {Select} from './Select'
import {SettingsRow} from './SettingsRow'

const MODELS = [
    {value: 'parakeet', label: 'Parakeet'},
    {value: 'turbo', label: 'Whisper Large V3 Turbo'},
    {value: 'medium', label: 'Whisper Medium'},
] as const

type Model = (typeof MODELS)[number]['value']

function Models({onChange}: { onChange?: (value: Model) => void }) {
    const [model, setModel] = useState<Model>('parakeet')
    return (
        <SettingsRow
            label="Model"
            description="After the meeting"
            control={(
                <Select
                    options={MODELS}
                    value={model}
                    onValueChange={(next) => {
                        setModel(next)
                        onChange?.(next)
                    }}
                />
            )}
        />
    )
}

// Radix Select scrolls the chosen option into view and tracks pointer
// capture; jsdom has neither.
beforeAll(() => {
    Element.prototype.scrollIntoView = () => {}
    Element.prototype.hasPointerCapture = () => false
    Element.prototype.releasePointerCapture = () => {}
})

describe('Select', () => {
    it('shows the choice on a button named by its row', () => {
        renderUi(<Models/>)

        const button = screen.getByRole('combobox', {name: 'Model'})
        expect(button).toHaveTextContent('Parakeet')
        expect(button).toHaveAccessibleDescription('After the meeting')
    })

    it('opens on the chosen option, moves with the arrows and chooses with Enter', async () => {
        const onChange = vi.fn()
        renderUi(<Models onChange={onChange}/>)
        const button = screen.getByRole('combobox', {name: 'Model'})

        button.focus()
        await userEvent.keyboard('{Enter}')
        await waitFor(() => expect(screen.getByRole('option', {name: 'Parakeet'})).toHaveFocus())

        await userEvent.keyboard('{ArrowDown}{Enter}')
        expect(onChange).toHaveBeenCalledWith('turbo')
        expect(button).toHaveTextContent('Whisper Large V3 Turbo')
        await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
        expect(button).toHaveFocus()
    })

    it('closes on Escape without a change', async () => {
        const onChange = vi.fn()
        renderUi(<Models onChange={onChange}/>)

        screen.getByRole('combobox', {name: 'Model'}).focus()
        await userEvent.keyboard('{Enter}')
        await screen.findByRole('listbox')
        await userEvent.keyboard('{ArrowDown}{Escape}')

        await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
        expect(onChange).not.toHaveBeenCalled()
        expect(screen.getByRole('combobox', {name: 'Model'})).toHaveTextContent('Parakeet')
    })

    it('turns a spinner in place of its caret while its options load', () => {
        const {rerender} = renderUi(
            <Select label="Model" placeholder="Loading models…" options={[]} value={undefined} onValueChange={() => {}} disabled pending/>,
        )
        const button = screen.getByRole('combobox', {name: 'Model'})
        const mark = () => getComputedStyle(button.querySelector('svg') as SVGElement).animationName

        expect(button).toHaveAttribute('aria-busy', 'true')
        expect(button).toHaveTextContent('Loading models…')
        expect(mark()).not.toMatch(/^(none)?$/)

        rerender(<Select label="Model" options={MODELS} value="turbo" onValueChange={() => {}}/>)
        expect(button).not.toHaveAttribute('aria-busy')
        expect(mark()).toMatch(/^(none)?$/)
    })
})
