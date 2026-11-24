import type {Meta, StoryObj} from '@storybook/react-vite'
import {GearSixIcon, PushPinIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {formatShortcut} from '@/lib/platform'
import {Button, IconButton} from './Button'
import {Tooltip} from './Tooltip'

const Row = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

// Hover one, then move to the next: inside the shared provider the second
// opens without waiting again. Tab focus opens them too.
function Tips() {
    return (
        <Row>
            <IconButton label="Settings" shortcut={formatShortcut(',')}><GearSixIcon size={17}/></IconButton>
            <IconButton label="Keep on top" pressed><PushPinIcon/></IconButton>
            <Tooltip content="Stop and save" shortcut={formatShortcut('S')}>
                <Button>Stop</Button>
            </Tooltip>
        </Row>
    )
}

const meta = {
    title: 'UI/Tooltip',
    component: Tips,
} satisfies Meta<typeof Tips>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
