import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {Folder} from '@/api/meetings'
import {FolderBar} from './FolderBar'

const folder = (id: string, name: string): Folder => ({id, name, meetingCount: 2, createdAt: '2026-11-01T10:00:00Z'})
const FOLDERS = [folder('acme', 'Acme Corp'), folder('design', 'Design Team'), folder('standup', 'Weekly Standup')]
const MANY = [...FOLDERS, folder('hiring', 'Hiring loop'), folder('board', 'Board')]

// Home's narrowest window.
const Column = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[4]};
    width: 460px;
`

function FolderBarDemo({folders, compare}: { folders: readonly Folder[], compare: boolean }) {
    const [selected, setSelected] = useState<string | null>(null)
    const bar = (chosen: string | null) => (
        <FolderBar
            folders={folders}
            selected={chosen}
            onSelect={setSelected}
            onNew={() => {}}
            onRename={() => {}}
            onDelete={() => {}}
        />
    )
    return (
        <Column>
            {compare ? <>{bar(null)}{bar(folders[0].id)}</> : bar(selected)}
        </Column>
    )
}

const meta = {
    title: 'Meetings/FolderBar',
    component: FolderBarDemo,
    args: {folders: FOLDERS, compare: false},
} satisfies Meta<typeof FolderBarDemo>

export default meta

type Story = StoryObj<typeof meta>

/** Pick a folder: only the thumb slides, and its actions button fades in after New folder. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/**
 * All above, Acme Corp below: the chips, the row's height and its divider
 * line up, since the actions button's place is held while All is selected.
 */
export const AllAndFolder: Story = {args: {compare: true}}

/** Chips that wrap: the held place wraps with them, so a choice never adds a line. */
export const Wrapped: Story = {args: {folders: MANY, compare: true}}
