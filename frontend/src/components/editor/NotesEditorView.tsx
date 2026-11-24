import '@blocknote/react/style.css'
import {useEffectEvent, useLayoutEffect, useRef} from 'react'
import type {BlockNoteEditor, PartialBlock} from '@blocknote/core'
import {en} from '@blocknote/core/locales'
import {BlockNoteViewRaw, useCreateBlockNote} from '@blocknote/react'
import * as m from 'motion/react-m'
import styled, {keyframes, useTheme} from 'styled-components'
import {blocksToMarkdownSafely} from '@/lib/blocknote-markdown'
import {tween} from '@/styles/motion'
import type {NotesEditorProps} from './types'

/**
 * BlockNote on `@blocknote/core` and `@blocknote/react` alone, with no UI
 * library: without one, BlockNoteView draws none of its menus (formatting
 * toolbar, slash menu, side menu, emoji picker), and the design shows none.
 * Formatting comes from Markdown shortcuts as you type (`- `, `1. `, `[] `,
 * `# `, `> `) and the usual keys (Ctrl B, Ctrl I, Tab to indent).
 * The default export is the lazy chunk NotesEditor loads.
 */
export default function NotesEditorView({
    initialBlocks,
    initialMarkdown,
    placeholder = 'Write your notes…',
    label = 'Notes',
    editable = true,
    autoFocus = false,
    onChange,
    onReady,
}: NotesEditorProps) {
    const theme = useTheme()
    const editor = useCreateBlockNote({
        dictionary: {
            ...en,
            // No slash menu, so no "type '/' for commands" on every empty line;
            // headings and list items keep their own hints.
            placeholders: {...en.placeholders, emptyDocument: placeholder, default: undefined},
        },
        domAttributes: {editor: {'aria-label': label}},
        // A block changing type would animate its font size, which lays the
        // window out again on every frame.
        animations: false,
    })

    // The content is read once per mount; NotesEditorProps says so.
    const initial = useRef({blocks: initialBlocks, markdown: initialMarkdown})
    // The last Markdown that converted, kept when a later conversion fails.
    const lastMarkdown = useRef(initialMarkdown ?? '')
    const reportChange = useEffectEvent(() => {
        const blocks = editor.document
        const result = blocksToMarkdownSafely(editor, blocks, {
            source: 'notes-editor',
            fallbackMarkdown: lastMarkdown.current,
        })
        if (result.ok && result.markdown !== undefined) lastMarkdown.current = result.markdown
        onChange?.({json: blocks, markdown: result.markdown ?? lastMarkdown.current})
    })
    const reportReady = useEffectEvent(() => onReady?.())

    // A layout effect, so the first frame already shows the notes. Loading
    // goes before the change listener: the loaded notes are not an edit.
    useLayoutEffect(() => {
        loadContent(editor, initial.current.blocks, initial.current.markdown)
        reportReady()
        return editor.onChange(() => reportChange())
    }, [editor])

    return (
        <Root initial={{opacity: 0}} animate={{opacity: 1}} transition={tween('base', 'enter')}>
            <BlockNoteViewRaw editor={editor} editable={editable} autoFocus={autoFocus} theme={theme.name}/>
        </Root>
    )
}

/**
 * Puts the stored notes into the editor: the blocks when there are any, else
 * (or when they cannot be read, such as a block type this version does not
 * know) the Markdown saved next to them.
 */
function loadContent(editor: BlockNoteEditor, blocks: unknown, markdown: string | null | undefined) {
    if (Array.isArray(blocks) && blocks.length > 0) {
        try {
            editor.replaceBlocks(editor.document, blocks as PartialBlock[])
            return
        } catch (error) {
            console.error('Could not read the notes as BlockNote blocks; loading their Markdown', error)
        }
    }
    if (!markdown?.trim()) return
    try {
        editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(markdown))
    } catch (error) {
        console.error('Could not read the notes as Markdown', error)
    }
}

const placeholderIn = keyframes`
    from {
        opacity: 0;
    }
`

// BlockNote's stylesheet arrives with this chunk, in an order against
// styled-components' that is not fixed. Its rules are one or two classes
// deep, so every override sits under `&&` (this class twice) and wins either
// way. BlockNote also sets a light or dark palette on .bn-root; only its
// highlight colours stay, for notes the old app saved with text colours.
const Root = styled(m.div)`
    display: flex;
    flex-direction: column;
    min-height: 100%;

    && .bn-root {
        --bn-font-family: ${({theme}) => theme.fonts.sans};
        --bn-colors-editor-text: ${({theme}) => theme.colors.text};
        --bn-colors-editor-background: transparent;
        --bn-colors-border: ${({theme}) => theme.colors.border};
        --bn-border-radius: ${({theme}) => theme.radii.sm};
    }

    && .bn-container {
        display: flex;
        flex: 1;
        flex-direction: column;
    }

    /* The host pads the panel; BlockNote's inline padding is room for its side menu. */
    && .bn-editor {
        flex: 1;
        padding-inline: 0;
        border-radius: 0;
        background: transparent;
        color: ${({theme}) => theme.colors.text};
        caret-color: ${({theme}) => theme.colors.text};
    }

    && .bn-default-styles {
        font-family: ${({theme}) => theme.fonts.sans};
        ${({theme}) => theme.text.notes};
    }

    /* Lines follow each other at the notes' line height, as in the design. */
    && .bn-block-outer {
        line-height: inherit;
        transition: none;
    }

    && .bn-block-content,
    && .bn-block-content::before {
        padding-block: 0;
        transition: none;
    }

    && .bn-block-group .bn-block-group {
        margin-left: ${({theme}) => theme.space[5]};
    }

    && .bn-block-content[data-content-type='heading'] {
        --level: 1em;
        --prev-level: 1em;
        padding-top: ${({theme}) => theme.space[3]};
    }

    && .bn-block-group > .bn-block-outer:first-child .bn-block-content[data-content-type='heading'] {
        padding-top: 0;
    }

    && .bn-block-content[data-content-type='heading'] .bn-inline-content {
        ${({theme}) => theme.text.notes};
        font-weight: ${({theme}) => theme.fontWeights.semibold};
    }

    && .bn-block-content[data-content-type='heading'][data-level='1'] .bn-inline-content {
        ${({theme}) => theme.text.notesHeading};
    }

    /* Markers take the indent of a nested list, so children line up with the text. */
    && .bn-block-content[data-content-type='bulletListItem']::before,
    && .bn-block-content[data-content-type='numberedListItem']::before {
        min-width: ${({theme}) => theme.space[5]};
        padding-right: 0;
    }

    && .bn-block-content[data-content-type='checkListItem'] > div:has(> input) {
        height: ${({theme}) => theme.text.notes.lineHeight};
    }

    && .bn-block-content[data-content-type='checkListItem'] > div > input {
        height: ${({theme}) => theme.text.notes.lineHeight};
        margin: 0 ${({theme}) => theme.space[1.5]} 0 ${({theme}) => theme.space[0.5]};
        accent-color: ${({theme}) => theme.colors.text};
    }

    && .bn-block-content[data-content-type='checkListItem'] .bn-inline-content {
        transition: color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    && .bn-block-content[data-content-type='checkListItem'][data-checked='true'] .bn-inline-content {
        color: ${({theme}) => theme.colors.muted};
    }

    && .bn-block-content[data-content-type='quote'] blockquote {
        padding-left: ${({theme}) => theme.space[3]};
        border-left: 2px solid ${({theme}) => theme.colors.border};
        color: ${({theme}) => theme.colors.soft};
    }

    && .bn-inline-content code {
        padding: 0 ${({theme}) => theme.space[1]};
        border-radius: ${({theme}) => theme.radii.xs};
        background: ${({theme}) => theme.colors.surface};
        font-family: ${({theme}) => theme.fonts.mono};
    }

    && .bn-block-content[data-content-type='codeBlock'] {
        margin-block: ${({theme}) => theme.space[1]};
        border-radius: ${({theme}) => theme.radii.md};
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }

    && .bn-block-content[data-content-type='codeBlock'] > pre {
        padding: ${({theme}) => theme.space[3]};
        font-family: ${({theme}) => theme.fonts.mono};
        ${({theme}) => theme.text.body};
    }

    && .bn-block-content[data-content-type='codeBlock'] > div > select {
        color: ${({theme}) => theme.colors.muted};
    }

    && .bn-editor a {
        color: inherit;
        text-decoration: underline;
        text-decoration-color: ${({theme}) => theme.colors.muted};
        text-underline-offset: ${({theme}) => theme.space[0.5]};
    }

    /* The placeholder fades in each time the notes become empty. */
    && .bn-block-content:has(.ProseMirror-trailingBreak:only-child)::after {
        color: ${({theme}) => theme.colors.muted};
        font-style: normal;
        animation: ${placeholderIn} ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.enter};
    }
`
