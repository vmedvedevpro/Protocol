import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {Button} from './Button'
import {Collapse} from './Collapse'

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
