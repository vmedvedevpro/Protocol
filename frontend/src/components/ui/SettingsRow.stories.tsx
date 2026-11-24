import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {Button} from './Button'
import {ProgressBar} from './ProgressBar'
import {SegmentedControl} from './SegmentedControl'
import {Select} from './Select'
import {SettingsGroup, SettingsNavRow, SettingsRow} from './SettingsRow'
import {Switch} from './Switch'
import {TextArea, TextField} from './TextField'

const Page = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3.5]};
    width: 428px;
`

const THEMES = [
    {value: 'light', label: 'Light'},
    {value: 'dark', label: 'Dark'},
    {value: 'system', label: 'System'},
] as const

const LANGUAGES = [
    {value: 'auto', label: 'Detect automatically'},
    {value: 'en', label: 'English'},
    {value: 'ru', label: 'Russian'},
] as const

// Rows from AppSettings: a segmented theme, a text field, switches, a select,
// a subpage, actions and a download in progress.
function Settings() {
    const [theme, setTheme] = useState<(typeof THEMES)[number]['value']>('system')
    const [name, setName] = useState('Tyler')
    const [saveAudio, setSaveAudio] = useState(true)
    const [autoSummary, setAutoSummary] = useState(false)
    const [language, setLanguage] = useState<(typeof LANGUAGES)[number]['value']>('auto')
    const [words, setWords] = useState('Acme\nPriya Shah\nParakeet')

    return (
        <Page>
            <SettingsGroup title="General">
                <SettingsRow
                    label="Theme"
                    control={<SegmentedControl label="Theme" options={THEMES} value={theme} onChange={setTheme}/>}
                />
                <SettingsRow
                    label="Your name"
                    description="Shown instead of “You” in transcripts"
                    control={<TextField size="sm" value={name} onChange={(event) => setName(event.target.value)} style={{width: 130}}/>}
                />
            </SettingsGroup>

            <SettingsGroup title="Recording" note="The defaults suit most meetings.">
                <SettingsRow
                    label="Save audio"
                    description="Keep the recording next to the transcript"
                    control={<Switch checked={saveAudio} onCheckedChange={setSaveAudio}/>}
                />
                <SettingsRow
                    label="Meeting language"
                    control={<Select options={LANGUAGES} value={language} onValueChange={setLanguage}/>}
                />
                <SettingsRow
                    label="Summarize automatically"
                    badge="Labs"
                    control={<Switch checked={autoSummary} onCheckedChange={setAutoSummary}/>}
                />
                <SettingsNavRow label="Summary model" value="Built-in · Qwen 3.5 4B" onClick={() => {}}/>
                <SettingsNavRow label="Release notes" external onClick={() => {}}/>
            </SettingsGroup>

            <SettingsGroup title="Speech models">
                <SettingsRow
                    label="Gemma 3 4B"
                    description="Downloading · 40%"
                    control={<Button size="sm">Cancel</Button>}
                >
                    <ProgressBar label="Downloading Gemma 3 4B" value={40}/>
                </SettingsRow>
                <SettingsRow label="Words to recognize" description="One per line: names, products, jargon">
                    <TextArea mono rows={4} value={words} onChange={(event) => setWords(event.target.value)}/>
                </SettingsRow>
            </SettingsGroup>
        </Page>
    )
}

const meta = {
    title: 'UI/SettingsRow',
    component: Settings,
} satisfies Meta<typeof Settings>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
