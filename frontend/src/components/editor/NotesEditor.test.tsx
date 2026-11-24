import {BlockNoteEditor, type PartialBlock} from '@blocknote/core'
import {fireEvent, render, screen, waitFor, within} from '@testing-library/react'
import {ThemeProvider} from 'styled-components'
import {describe, expect, it, vi} from 'vitest'
import {SAMPLE_MARKDOWN_ONLY_NOTES, SAMPLE_NOTES_BLOCKS, SAMPLE_NOTES_MARKDOWN} from '@/mocks/notes'
import {lightTheme} from '@/styles/theme'
import {NotesEditor} from './NotesEditor'
import type {NotesEditorProps} from './types'

function renderEditor(props: NotesEditorProps = {}) {
    return render(
        <ThemeProvider theme={lightTheme}>
            <NotesEditor {...props}/>
        </ThemeProvider>,
    )
}

describe('the stored format', () => {
    // The fixture is BlockNote 0.36 JSON, as the old app saved it.
    it('reads the blocks the old app saved and gives them back unchanged', () => {
        const editor = BlockNoteEditor.create({initialContent: SAMPLE_NOTES_BLOCKS as PartialBlock[]})

        expect(editor.document).toEqual(SAMPLE_NOTES_BLOCKS)
        expect(editor.blocksToMarkdownLossy(editor.document)).toBe(SAMPLE_NOTES_MARKDOWN)
    })
})

describe('NotesEditor', () => {
    it('shows notes saved as blocks', async () => {
        renderEditor({initialBlocks: SAMPLE_NOTES_BLOCKS, initialMarkdown: SAMPLE_NOTES_MARKDOWN})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(within(notes).getByText('Legal wants it in writing: nothing leaves the laptop')).toBeInTheDocument()
        expect(within(notes).getByRole('heading', {name: 'Follow-ups', level: 2})).toBeInTheDocument()
        const [draft, shared] = within(notes).getAllByRole('checkbox')
        expect(draft).not.toBeChecked()
        expect(shared).toBeChecked()
    })

    it('reads the Markdown when no blocks were saved', async () => {
        renderEditor({initialMarkdown: SAMPLE_MARKDOWN_ONLY_NOTES})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(within(notes).getByRole('heading', {name: 'Q4 roadmap', level: 1})).toBeInTheDocument()
        expect(within(notes).getByText('Calendar import after the pilot')).toBeInTheDocument()
    })

    it('reads the Markdown when the blocks cannot be read', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

        renderEditor({initialBlocks: [{type: 'whiteboard', props: {}}], initialMarkdown: SAMPLE_MARKDOWN_ONLY_NOTES})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(within(notes).getByRole('heading', {name: 'Q4 roadmap'})).toBeInTheDocument()
        expect(consoleError).toHaveBeenCalledWith(
            'Could not read the notes as BlockNote blocks; loading their Markdown',
            expect.anything(),
        )
    })

    it('reports blocks and Markdown on an edit, not on loading', async () => {
        const onChange = vi.fn()
        const onReady = vi.fn()
        renderEditor({initialBlocks: SAMPLE_NOTES_BLOCKS, onChange, onReady})
        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(onReady).toHaveBeenCalledTimes(1)
        expect(onChange).not.toHaveBeenCalled()

        // A click without the pointer's mousedown: ProseMirror would place the
        // caret from layout, and jsdom has none.
        fireEvent.click(within(notes).getAllByRole('checkbox')[0])

        await waitFor(() => expect(onChange).toHaveBeenCalled())
        const {json, markdown} = onChange.mock.lastCall![0]
        expect(json).toHaveLength(SAMPLE_NOTES_BLOCKS.length)
        expect(json[4]).toMatchObject({type: 'checkListItem', props: {checked: true}})
        expect(markdown).toContain('* [x] Draft the retention statement')
    })

    it('is read-only when not editable', async () => {
        renderEditor({initialBlocks: SAMPLE_NOTES_BLOCKS, editable: false})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(notes).toHaveAttribute('contenteditable', 'false')
    })
})
