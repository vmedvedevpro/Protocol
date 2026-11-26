import {BlockNoteEditor, type PartialBlock} from '@blocknote/core'
import {fireEvent, screen, waitFor, within} from '@testing-library/react'
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {SAMPLE_MARKDOWN_ONLY_NOTES, SAMPLE_NOTES_BLOCKS, SAMPLE_NOTES_MARKDOWN} from '@/mocks/notes'
import {renderUi} from '@/test/renderUi'
import {NotesEditor, type NotesEditorProps} from './NotesEditor'

function renderEditor(props: NotesEditorProps = {}) {
    return renderUi(<NotesEditor {...props}/>)
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
    // The editor is a lazy chunk (BlockNote, ProseMirror, Ariakit). On a cold
    // CI runner importing it takes longer than findBy* waits, so it loads
    // before the tests and each test waits only for its own render.
    beforeAll(async () => {
        await import('./NotesEditorView')
    })

    it('shows notes saved as blocks', async () => {
        renderEditor({initialBlocks: SAMPLE_NOTES_BLOCKS, initialMarkdown: SAMPLE_NOTES_MARKDOWN})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(within(notes).getByText('Legal wants it in writing: nothing leaves the laptop')).toBeInTheDocument()
        expect(within(notes).getByRole('heading', {name: 'Follow-ups', level: 2})).toBeInTheDocument()
        const [draft, shared] = within(notes).getAllByRole('checkbox')
        expect(draft).not.toBeChecked()
        expect(shared).toBeChecked()
        // Each checkbox is named by its item's text.
        expect(draft).toHaveAccessibleName('Draft the retention statement')
    })

    it('reads the Markdown when no blocks were saved', async () => {
        renderEditor({initialMarkdown: SAMPLE_MARKDOWN_ONLY_NOTES})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(within(notes).getByRole('heading', {name: 'Q4 roadmap', level: 1})).toBeInTheDocument()
        expect(within(notes).getByText('Calendar import after the pilot')).toBeInTheDocument()
    })

    // A summary whose action items were put back (#218) is stored without
    // blocks: the editor builds them from its Markdown, table and done marks included.
    it('builds a restored summary from its Markdown, with its table and checked items', async () => {
        const markdown = [
            '## Action Items',
            '',
            '| Owner | Task | Due |',
            '| --- | --- | --- |',
            '| Priya | Send the terms | Friday |',
            '',
            '- [ ] Call the venue',
            '- [x] You: Draft the FAQ (due Monday)',
        ].join('\n')
        renderEditor({initialMarkdown: markdown})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        const table = within(notes).getByRole('table')
        expect(within(table).getByText('Send the terms')).toBeInTheDocument()
        expect(within(table).getByText('Friday')).toBeInTheDocument()
        const [venue, faq] = within(notes).getAllByRole('checkbox')
        expect(venue).toHaveAccessibleName('Call the venue')
        expect(venue).not.toBeChecked()
        expect(faq).toHaveAccessibleName('You: Draft the FAQ (due Monday)')
        expect(faq).toBeChecked()
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

    it('puts the caret in the notes with autoFocus', async () => {
        renderEditor({initialBlocks: SAMPLE_NOTES_BLOCKS, autoFocus: true})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        await waitFor(() => expect(notes).toHaveFocus())
    })

    it('is read-only when not editable', async () => {
        renderEditor({initialBlocks: SAMPLE_NOTES_BLOCKS, editable: false})

        const notes = await screen.findByRole('textbox', {name: 'Notes'})
        expect(notes).toHaveAttribute('contenteditable', 'false')
    })
})
