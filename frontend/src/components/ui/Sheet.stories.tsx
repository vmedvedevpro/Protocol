import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {Button} from './Button'
import {SegmentedControl} from './SegmentedControl'
import {Select} from './Select'
import {SettingsGroup, SettingsRow} from './SettingsRow'
import {Sheet, SheetClose} from './Sheet'
import {TextArea} from './TextField'

const Window = styled.div`
    display: grid;
    place-items: center;
    width: 100vw;
    height: 100vh;
`

const Stack = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3.5]};
`

const TEMPLATES = [
    {value: 'standard', label: 'Standard Meeting Notes'},
    {value: 'standup', label: 'Daily standup'},
] as const

const LANGUAGES = [
    {value: 'same', label: 'Same as the transcript'},
    {value: 'en', label: 'English'},
] as const

const LINKS = [
    {value: 'obsidian', label: 'Obsidian'},
    {value: 'markdown', label: 'Markdown'},
] as const

// The summary options sheet from the AppSheet artboard, open at first.
function SummaryOptions() {
    const [open, setOpen] = useState(true)
    const [template, setTemplate] = useState<(typeof TEMPLATES)[number]['value']>('standard')
    const [language, setLanguage] = useState<(typeof LANGUAGES)[number]['value']>('same')
    const [links, setLinks] = useState<(typeof LINKS)[number]['value']>('obsidian')

    return (
        <Window>
            <Sheet
                open={open}
                onOpenChange={setOpen}
                trigger={<Button>Summary options</Button>}
                title="Summary options"
                description="Write the summary again with another template, language or instruction."
                footer={(
                    <>
                        <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                        <Button variant="filled" onClick={() => setOpen(false)}>Write again</Button>
                    </>
                )}
            >
                <Stack>
                    <SettingsGroup>
                        <SettingsRow
                            label="Template"
                            control={<Select options={TEMPLATES} value={template} onValueChange={setTemplate}/>}
                        />
                        <SettingsRow
                            label="Language"
                            description="For this meeting only"
                            control={<Select options={LANGUAGES} value={language} onValueChange={setLanguage}/>}
                        />
                        <SettingsRow
                            label="Links"
                            control={<SegmentedControl label="Link style" options={LINKS} value={links} onChange={setLinks}/>}
                        />
                    </SettingsGroup>
                    <TextArea
                        label="Write it again"
                        placeholder="Anything to focus on? For example: only the decisions about the pilot"
                    />
                </Stack>
            </Sheet>
        </Window>
    )
}

const meta = {
    title: 'UI/Sheet',
    component: SummaryOptions,
    parameters: {layout: 'fullscreen'},
} satisfies Meta<typeof SummaryOptions>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Reduced motion: the sheet and the scrim only fade. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
