import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {fn} from 'storybook/test'
import {SAMPLE_MARKDOWN_ONLY_NOTES, SAMPLE_NOTES_BLOCKS, SAMPLE_NOTES_MARKDOWN} from '@/mocks/notes'
import {NotesEditor} from './NotesEditor'

// The Notes tab of the 460 px window: the window minus its title strip and
// bottom bar, padded as the design's tab panel.
const Panel = styled.div`
    width: ${({theme}) => theme.sizes.window.width};
    height: calc(${({theme}) => theme.sizes.window.height} - ${({theme}) => theme.sizes.bar.header} - ${({theme}) => theme.sizes.bar.footer});
    overflow-y: auto;
    padding: ${({theme}) => theme.space[3.5]} ${({theme}) => theme.space[5]} ${({theme}) => theme.space[4]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    background: ${({theme}) => theme.colors.bg};
`

const meta = {
    title: 'Editor/NotesEditor',
    component: NotesEditor,
    decorators: [(Story) => <Panel><Story/></Panel>],
    args: {onChange: fn(), onReady: fn()},
} satisfies Meta<typeof NotesEditor>

export default meta

type Story = StoryObj<typeof meta>

const saved = {initialBlocks: SAMPLE_NOTES_BLOCKS, initialMarkdown: SAMPLE_NOTES_MARKDOWN}

/** Notes the old app saved: blocks and Markdown. */
export const Light: Story = {globals: {theme: 'light'}, args: saved}

export const Dark: Story = {globals: {theme: 'dark'}, args: saved}

/** No notes yet: the placeholder. */
export const Empty: Story = {globals: {theme: 'light'}}

export const EmptyDark: Story = {globals: {theme: 'dark'}}

/** Notes saved as Markdown only, read into blocks. */
export const FromMarkdown: Story = {globals: {theme: 'light'}, args: {initialMarkdown: SAMPLE_MARKDOWN_ONLY_NOTES}}

export const ReadOnly: Story = {globals: {theme: 'light'}, args: {...saved, editable: false}}
