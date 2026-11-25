import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {Button} from './Button'
import {Collapse} from './Collapse'
import {SettingsGroup, SettingsRow} from './SettingsRow'
import {Switch} from './Switch'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    width: 320px;
`

const Text = styled.p`
    margin-top: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// A disclosure over a paragraph: opening slides the paragraph down as the
// content grows, closing slides it back. Reset's focus ring, drawn outside
// the button at the content's edge, shows that the clip lets go once open.
function Disclosure() {
    const [open, setOpen] = useState(false)
    return (
        <Column>
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
                {open ? 'Hide details' : 'Show details'}
            </Button>
            <Collapse open={open}>
                <Text>
                    Crash time and type, Protocol version, coarse operating-system details, bucketed CPU core count,
                    and rounded memory size.
                </Text>
                <Text>No audio, recordings, transcripts, summaries or meeting names.</Text>
                <Button size="sm">Reset</Button>
            </Collapse>
            <Text>What follows the disclosure slides instead of jumping.</Text>
        </Column>
    )
}

// Settings › Recording › Saving: a Collapse inside a row, after the row's
// line and its gap, and one on the card, under its hairline. Both slide to
// where the layout ends; neither snaps by the gap or the hairline at the end.
function SettingsCard() {
    const [on, setOn] = useState(true)
    return (
        <div style={{width: 420}}>
            <SettingsGroup title="Saving">
                <SettingsRow label="Save audio" description="For playback" control={<Switch checked={on} onCheckedChange={setOn}/>}>
                    <Collapse open={!on}><Text>Audio isn’t being saved.</Text></Collapse>
                </SettingsRow>
                <Collapse open={on}>
                    <SettingsRow label="Where recordings are saved" description="Saved as MP4"/>
                </Collapse>
                <SettingsRow label="Format" description="MP4"/>
            </SettingsGroup>
        </div>
    )
}

const meta = {
    title: 'UI/Collapse',
    component: Disclosure,
} satisfies Meta<typeof Disclosure>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Reduced motion: the content appears and goes at once. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}

/** In a settings card: the row's gap and the card's hairline go with the height. */
export const InSettingsCard: Story = {globals: {theme: 'light'}, render: () => <SettingsCard/>}
