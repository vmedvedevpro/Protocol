import {FolderSimpleIcon} from '@phosphor-icons/react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {SpacedParts} from './SpacedParts'

const Frame = styled.div`
    width: 320px;
    padding: ${({theme}) => theme.space[4]};
    background: ${({theme}) => theme.colors.bg};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

function Example() {
    return (
        <Frame>
            <SpacedParts parts={['Today, 9:30 AM', '45 min', <><FolderSimpleIcon size={12} aria-hidden/>Weekly Standup with a long folder name</>]}/>
        </Frame>
    )
}

const meta = {
    title: 'UI/SpacedParts',
    component: Example,
} satisfies Meta<typeof Example>

export default meta

type Story = StoryObj<typeof meta>

/** A meeting's date, length and folder; parts wrap whole when the line runs out. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
