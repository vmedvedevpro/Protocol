import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {useState} from 'react'
import {renderUi} from '@/test/renderUi'
import {
    SettingsGroup,
    SettingsNavRow,
    SettingsRadioGroup,
    SettingsRadioRow,
    SettingsRow,
    SettingsSearchScope,
} from './SettingsRow'
import {matchesTerms, searchTerms} from './settingsSearch'
import {Switch} from './Switch'
import {TextField} from './TextField'

describe('SettingsRow', () => {
    it('names and describes its control with its own text', () => {
        renderUi(
            <SettingsGroup title="Recording">
                <SettingsRow
                    label="Save audio"
                    description="Keep the recording next to the transcript"
                    control={<Switch checked onCheckedChange={() => {}}/>}
                />
                <SettingsRow label="Your name" control={<TextField size="sm" defaultValue="Tyler"/>}/>
            </SettingsGroup>,
        )

        expect(screen.getByRole('region', {name: 'Recording'})).toBeInTheDocument()
        const toggle = screen.getByRole('switch', {name: 'Save audio'})
        expect(toggle).toHaveAccessibleDescription('Keep the recording next to the transcript')
        expect(screen.getByRole('textbox', {name: 'Your name'})).toHaveValue('Tyler')
    })

    it('opens a subpage from a nav row', async () => {
        const open = vi.fn()
        renderUi(<SettingsNavRow label="Summary model" value="Built-in" onClick={open}/>)

        await userEvent.click(screen.getByRole('button', {name: /Summary model/}))
        expect(open).toHaveBeenCalledOnce()
    })

    it('says that an external row opens in the browser', () => {
        renderUi(<SettingsNavRow label="Report a bug" external onClick={() => {}}/>)

        expect(screen.getByRole('button', {name: 'Report a bug (opens in browser)'})).toBeInTheDocument()
    })
})

function Sections({query = '', onMatches}: {query?: string, onMatches?: (count: number) => void}) {
    return (
        <SettingsSearchScope query={query} scope="AI" onMatches={onMatches}>
            <SettingsGroup title="Summaries" note="Written when a recording is saved.">
                <SettingsRow label="Summarize automatically" description="When a recording is saved" control={<Switch checked onCheckedChange={() => {}}/>}/>
                <SettingsNavRow label="Summary model" value="Built-in · Qwen 3.5 4B" onClick={() => {}}/>
                <SettingsNavRow label="Templates" description="The sections a summary is written in" onClick={() => {}}/>
            </SettingsGroup>
            <SettingsGroup title="Labs">
                <SettingsRow label="Voice profiles" badge="Labs" control={<Switch checked={false} onCheckedChange={() => {}}/>}/>
            </SettingsGroup>
        </SettingsSearchScope>
    )
}

describe('settings search', () => {
    it('matches every word of the query in a row’s label, description, badge or value', () => {
        expect(matchesTerms(searchTerms('model qwen'), 'Summary model', 'Built-in · Qwen 3.5 4B')).toBe(true)
        expect(matchesTerms(searchTerms('SAVED'), 'Summarize automatically', 'When a recording is saved')).toBe(true)
        expect(matchesTerms(searchTerms('model ollama'), 'Summary model', 'Built-in · Qwen 3.5 4B')).toBe(false)
    })

    it('shows every row and note while the query is blank', () => {
        renderUi(<Sections query="  "/>)

        expect(screen.getByRole('region', {name: 'Summaries'})).toBeInTheDocument()
        expect(screen.getByText('Written when a recording is saved.')).toBeInTheDocument()
        expect(screen.getByRole('switch', {name: 'Voice profiles'})).toBeInTheDocument()
    })

    it('keeps the rows that match, under their section’s name, and hides groups without one', () => {
        renderUi(<Sections query="summary"/>)

        const group = screen.getByRole('region', {name: 'AI · Summaries'})
        expect(group).toBeVisible()
        expect(screen.getByRole('button', {name: /Summary model/})).toBeInTheDocument()
        expect(screen.getByRole('button', {name: /Templates/})).toBeInTheDocument()
        expect(screen.queryByRole('switch', {name: 'Summarize automatically'})).not.toBeInTheDocument()
        expect(screen.queryByText('Written when a recording is saved.')).not.toBeInTheDocument()
        expect(screen.queryByRole('region', {name: 'AI · Labs'})).not.toBeInTheDocument()
    })

    it('brings rows back as the query changes', () => {
        const {rerender} = renderUi(<Sections query="labs"/>)
        expect(screen.getByRole('switch', {name: 'Voice profiles'})).toBeInTheDocument()
        expect(screen.queryByRole('region', {name: 'AI · Summaries'})).not.toBeInTheDocument()

        rerender(<Sections query="automatically"/>)

        expect(screen.queryByRole('switch', {name: 'Voice profiles'})).not.toBeInTheDocument()
        expect(screen.getByRole('switch', {name: 'Summarize automatically'})).toBeInTheDocument()
        rerender(<Sections/>)
        expect(screen.getByRole('switch', {name: 'Voice profiles'})).toBeInTheDocument()
        expect(screen.getByRole('button', {name: /Summary model/})).toBeInTheDocument()
    })

    it('counts the rows that match', () => {
        const onMatches = vi.fn()
        const {rerender} = renderUi(<Sections query="summar" onMatches={onMatches}/>)
        expect(onMatches).toHaveBeenLastCalledWith(3)

        rerender(<Sections query="nothing like it" onMatches={onMatches}/>)
        expect(onMatches).toHaveBeenLastCalledWith(0)
    })
})

function Providers({query = ''}: {query?: string}) {
    const [provider, setProvider] = useState<string>('builtin-ai')
    return (
        <SettingsSearchScope query={query}>
            <SettingsRadioGroup title="Provider" value={provider} onValueChange={setProvider}>
                <SettingsRadioRow value="builtin-ai" label="Built-in AI" description="No API key needed" badge="Recommended"/>
                <SettingsRadioRow value="claude" label="Claude" description="Anthropic API key"/>
                <SettingsRadioRow value="ollama" label="Ollama" description="Models on your own Ollama server"/>
            </SettingsRadioGroup>
        </SettingsSearchScope>
    )
}

describe('SettingsRadioGroup', () => {
    it('names the choice by its title and each option by its label', () => {
        renderUi(<Providers/>)

        expect(screen.getByRole('radiogroup', {name: 'Provider'})).toBeInTheDocument()
        const builtIn = screen.getByRole('radio', {name: 'Built-in AI'})
        expect(builtIn).toBeChecked()
        expect(builtIn).toHaveAccessibleDescription('No API key needed')
        expect(screen.getByRole('radio', {name: 'Claude'})).not.toBeChecked()
    })

    it('chooses on a click and with the arrow keys', async () => {
        renderUi(<Providers/>)

        await userEvent.click(screen.getByRole('radio', {name: 'Claude'}))
        expect(screen.getByRole('radio', {name: 'Claude'})).toBeChecked()
        expect(screen.getByRole('radio', {name: 'Built-in AI'})).not.toBeChecked()

        // Radix chooses the row that focus moves to while the arrow is down,
        // and moves focus a task after the keydown.
        await userEvent.keyboard('{ArrowDown>}')
        await waitFor(() => expect(screen.getByRole('radio', {name: 'Ollama'})).toHaveFocus())
        await userEvent.keyboard('{/ArrowDown}')
        expect(screen.getByRole('radio', {name: 'Ollama'})).toBeChecked()
    })

    it('rings a tile only while it has keyboard focus', () => {
        renderUi(
            <SettingsRadioGroup title="Format" layout="grid" value="md" onValueChange={() => {}}>
                <SettingsRadioRow value="md" label="Markdown"/>
                <SettingsRadioRow value="txt" label="Text"/>
            </SettingsRadioGroup>,
        )

        for (const name of ['Markdown', 'Text']) {
            expect(getComputedStyle(screen.getByRole('radio', {name})).outlineStyle).not.toBe('solid')
        }
    })

    it('leaves every option unchosen for a value none of them has', () => {
        renderUi(
            <SettingsRadioGroup title="Provider" value="removed-provider" onValueChange={() => {}}>
                <SettingsRadioRow value="claude" label="Claude"/>
            </SettingsRadioGroup>,
        )

        expect(screen.getByRole('radio', {name: 'Claude'})).not.toBeChecked()
    })

    it('filters its options in a search', () => {
        renderUi(<Providers query="api key"/>)

        expect(screen.getByRole('radio', {name: 'Built-in AI'})).toBeInTheDocument()
        expect(screen.getByRole('radio', {name: 'Claude'})).toBeInTheDocument()
        expect(screen.queryByRole('radio', {name: 'Ollama'})).not.toBeInTheDocument()
    })
})
