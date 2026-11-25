import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {DotsThreeIcon, FileZipIcon, GearSixIcon, PaperPlaneTiltIcon, PushPinIcon, XIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {formatShortcut} from '@/lib/platform'
import {Button, IconButton} from './Button'
import {Kbd} from './Kbd'

const Board = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[4]};
`

const Row = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

// The artboards' buttons: a sheet's footer, Record with its shortcut, a
// banner's small actions, and the header's icon buttons. The second row
// waits: a spinner stands in for the clicked button's label, at its width.
function Buttons() {
    const [onTop, setOnTop] = useState(true)
    return (
        <Board>
            <Row>
                <Button variant="ghost">Cancel</Button>
                <Button variant="filled">Export</Button>
                <Button variant="filled" disabled>Export</Button>
            </Row>
            <Row>
                <Button variant="ghost" disabled>Ignore</Button>
                <Button disabled><FileZipIcon aria-hidden/>Save ZIP</Button>
                <Button variant="filled" pending><PaperPlaneTiltIcon aria-hidden/>Send Report</Button>
            </Row>
            <Row>
                <Button variant="filled" trailing={<Kbd tone="fill">{formatShortcut('R')}</Kbd>}>Record</Button>
                <Button>Summarize so far</Button>
                <Button disabled>Summarize so far</Button>
            </Row>
            <Row>
                <Button size="sm" variant="ghost">Not now</Button>
                <Button size="sm" variant="filled">Switch</Button>
                <Button size="sm">Cancel</Button>
            </Row>
            <Row>
                <IconButton label="Settings" shortcut={formatShortcut(',')}><GearSixIcon size={17}/></IconButton>
                <IconButton label="Keep on top" pressed={onTop} onClick={() => setOnTop(!onTop)}>
                    <PushPinIcon/>
                </IconButton>
                <IconButton label="More actions"><DotsThreeIcon/></IconButton>
                <IconButton label="Close" size="md"><XIcon size={12}/></IconButton>
            </Row>
        </Board>
    )
}

const meta = {
    title: 'UI/Button',
    component: Buttons,
} satisfies Meta<typeof Buttons>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
