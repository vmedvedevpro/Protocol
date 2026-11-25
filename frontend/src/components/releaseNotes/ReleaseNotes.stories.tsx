import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {createMockUpdateRelease} from '@/mocks/updater'
import {ReleaseNotes} from './ReleaseNotes'

// About as wide as the notes are in Settings.
const Column = styled.div`
    width: 400px;
`

const meta = {
    title: 'Updates/ReleaseNotes',
    component: ReleaseNotes,
    args: {notes: createMockUpdateRelease().notes ?? ''},
    decorators: [(Story) => <Column><Story/></Column>],
} satisfies Meta<typeof ReleaseNotes>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
