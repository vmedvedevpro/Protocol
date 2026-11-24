import '@blocknote/ariakit/style.css'
import {type ComponentProps, useEffectEvent, useLayoutEffect, useRef} from 'react'
import type {
    BlockNoteEditor,
    DefaultBlockSchema,
    DefaultInlineContentSchema,
    DefaultStyleSchema,
    PartialBlock,
} from '@blocknote/core'
import {en} from '@blocknote/core/locales'
import {BlockNoteView} from '@blocknote/ariakit'
import {
    DragHandleButton,
    EmojiPickerController,
    FilePanelController,
    type FloatingUIOptions,
    FormattingToolbarController,
    LinkToolbarController,
    SideMenu,
    SideMenuController,
    type SideMenuProps,
    SuggestionMenuController,
    useCreateBlockNote,
} from '@blocknote/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {blocksToMarkdownSafely} from '@/lib/blocknote-markdown'
import {durations, tween} from '@/styles/motion'
import {editorStyles} from './editorStyles'
import type {NotesEditorProps} from './types'

/**
 * BlockNote with the old editor's menus: the formatting toolbar on a
 * selection, the slash menu, the emoji picker (`:` and two letters), the link
 * toolbar, the file panel, table handles, and the drag handle with its block
 * menu. Their components come from @blocknote/ariakit; editorStyles restyles
 * them from the theme. The default export is the lazy chunk NotesEditor loads.
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
    const editor = useCreateBlockNote({
        dictionary: {
            ...en,
            placeholders: {
                ...en.placeholders,
                emptyDocument: placeholder,
                default: "Type '/' for headings, lists, and checklists",
            },
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
            <Editor
                editor={editor}
                editable={editable}
                autoFocus={autoFocus}
                portalElements={PORTALS}
                // The controllers below replace these, with the menu motion.
                formattingToolbar={false}
                linkToolbar={false}
                slashMenu={false}
                emojiPicker={false}
                sideMenu={false}
                filePanel={false}
            >
                <FormattingToolbarController floatingUIOptions={MENU_MOTION}/>
                <LinkToolbarController floatingUIOptions={MENU_MOTION}/>
                <SuggestionMenuController
                    triggerCharacter="/"
                    shouldOpen={(state) => !state.selection.$from.parent.type.isInGroup('tableContent')}
                    floatingUIOptions={MENU_MOTION}
                />
                <EmojiPickerController triggerCharacter=":" floatingUIOptions={MENU_MOTION}/>
                <SideMenuController sideMenu={DragHandleOnly} floatingUIOptions={SIDE_MENU_OPTIONS}/>
                <FilePanelController floatingUIOptions={MENU_MOTION}/>
            </Editor>
        </Root>
    )
}

/**
 * The menus render into a layer on <body>, so the scrolling panel around the
 * notes cannot clip them; BlockNote gives that layer the editor's classes.
 */
const PORTALS = {default: 'body'}

// Menus and popovers fade over `fast` (UI_ARCHITECTURE.md, Motion); their
// scale from 0.96 is in editorStyles.
const MENU_MOTION: FloatingUIOptions = {useTransitionStylesProps: {duration: durations.fast}}

type Middleware = NonNullable<NonNullable<FloatingUIOptions['useFloatingOptions']>['middleware']>[number]

/**
 * Centres the drag handle on its block's first line. BlockNote moves it down
 * by constants made for its own heading sizes (27 px for a level-2 heading),
 * and the notes' headings are smaller, so it measures the line instead.
 */
const onFirstLine: Middleware = {
    name: 'onFirstLine',
    fn({y, elements, rects}) {
        // The reference is BlockNote's virtual element around the block.
        const block = (elements.reference as {contextElement?: Element}).contextElement
        const text = block?.querySelector('.bn-inline-content')
        if (!block || !text) return {}
        const line = parseFloat(getComputedStyle(text).lineHeight)
        if (!Number.isFinite(line)) return {}
        const lineTop = text.getBoundingClientRect().top - block.getBoundingClientRect().top
        return {y: y + lineTop + (line - rects.floating.height) / 2}
    },
}

const SIDE_MENU_OPTIONS: FloatingUIOptions = {...MENU_MOTION, useFloatingOptions: {middleware: [onFirstLine]}}

/**
 * The side menu without its + button: the design keeps the text 20 px from
 * the window's edge, and that gutter holds the drag handle alone. A '/' on
 * any line opens what + did, and the handle opens the block menu.
 */
function DragHandleOnly(props: SideMenuProps) {
    return (
        <SideMenu {...props}>
            <DragHandleButton {...props}/>
        </SideMenu>
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

const Root = styled(m.div)`
    display: flex;
    flex-direction: column;
    min-height: 100%;
`

type ViewProps = Omit<
    ComponentProps<typeof BlockNoteView<DefaultBlockSchema, DefaultInlineContentSchema, DefaultStyleSchema>>,
    'theme'
>

/**
 * BlockNoteView in the app's light or dark scheme. Its own `theme` prop
 * cannot go through styled(), which reads `theme` as the styled-components
 * theme.
 */
function SchemedView(props: ViewProps) {
    const theme = useTheme()
    return <BlockNoteView {...props} theme={theme.name}/>
}

const Editor = styled(SchemedView)`
    ${editorStyles}
`
