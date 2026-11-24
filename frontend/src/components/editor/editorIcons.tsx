import type {ComponentType, ReactNode} from 'react'
import {components as ariakit} from '@blocknote/ariakit'
import {type BlockNoteEditor, getDefaultSlashMenuItems} from '@blocknote/core'
import {en} from '@blocknote/core/locales'
import {
    type BlockTypeSelectItem,
    type Components,
    type DefaultReactSuggestionItem,
} from '@blocknote/react'
import {
    ArrowSquareOutIcon,
    CaretRightIcon,
    CodeBlockIcon,
    CodeIcon,
    DotsSixVerticalIcon,
    DownloadSimpleIcon,
    EyeIcon,
    FileIcon,
    FilmStripIcon,
    type Icon,
    ImageIcon,
    LinkBreakIcon,
    LinkIcon,
    ListBulletsIcon,
    ListChecksIcon,
    ListNumbersIcon,
    MinusIcon,
    QuotesIcon,
    SmileyIcon,
    SpeakerHighIcon,
    SubtitlesIcon,
    SwapIcon,
    TableIcon,
    TextAaIcon,
    TextAlignCenterIcon,
    TextAlignJustifyIcon,
    TextAlignLeftIcon,
    TextAlignRightIcon,
    TextBIcon,
    TextHFiveIcon,
    TextHFourIcon,
    TextHOneIcon,
    TextHSixIcon,
    TextHThreeIcon,
    TextHTwoIcon,
    TextIndentIcon,
    TextItalicIcon,
    TextOutdentIcon,
    TextStrikethroughIcon,
    TextTIcon,
    TextUnderlineIcon,
    TrashIcon,
} from '@phosphor-icons/react'

/*
 * BlockNote draws react-icons; the app draws Phosphor. These swap them where
 * BlockNote takes an icon from outside: slash menu and block type items, the
 * skin's buttons and form fields (ComponentsContext), and the table handles'
 * children (NotesEditorView). Icons BlockNote draws inside its blocks (the file, image, video
 * and audio placeholders) and the cell merge button, which changes its icon
 * under one label, stay BlockNote's.
 */

/** By BlockNote's slash menu key, which also names the block types. */
const blockIcons: Partial<Record<string, Icon>> = {
    heading: TextHOneIcon,
    heading_2: TextHTwoIcon,
    heading_3: TextHThreeIcon,
    heading_4: TextHFourIcon,
    heading_5: TextHFiveIcon,
    heading_6: TextHSixIcon,
    toggle_heading: TextHOneIcon,
    toggle_heading_2: TextHTwoIcon,
    toggle_heading_3: TextHThreeIcon,
    quote: QuotesIcon,
    toggle_list: CaretRightIcon,
    numbered_list: ListNumbersIcon,
    bullet_list: ListBulletsIcon,
    check_list: ListChecksIcon,
    paragraph: TextTIcon,
    code_block: CodeBlockIcon,
    table: TableIcon,
    image: ImageIcon,
    video: FilmStripIcon,
    audio: SpeakerHighIcon,
    file: FileIcon,
    emoji: SmileyIcon,
    divider: MinusIcon,
}

/** The slash menu's items, as BlockNote builds them, with Phosphor icons. */
export function slashMenuItems(editor: BlockNoteEditor): DefaultReactSuggestionItem[] {
    return getDefaultSlashMenuItems(editor).map((item) => {
        const ItemIcon = blockIcons[item.key]
        return ItemIcon ? {...item, icon: <ItemIcon/>} : item
    })
}

// The block type select names its items by their slash menu titles only.
const blockIconsByTitle = new Map(
    Object.entries(blockIcons).map(([key, BlockIcon]) => [
        en.slash_menu[key as keyof typeof en.slash_menu].title,
        BlockIcon,
    ]),
)

/** The formatting toolbar's block type items with Phosphor icons. */
export function withBlockTypeIcons(items: BlockTypeSelectItem[]): BlockTypeSelectItem[] {
    return items.map((item) => ({...item, icon: blockIconsByTitle.get(item.name) ?? item.icon}))
}

const fileTypes = (labels: Record<string, string>, LabelIcon: Icon) =>
    Object.values(labels).map((label): [string, Icon] => [label, LabelIcon])

const toolbar = en.formatting_toolbar

/**
 * By the label (or a field's placeholder) BlockNote gives a button. The
 * editor uses BlockNote's English dictionary; a label missing here, such as
 * one a later BlockNote renames, keeps BlockNote's icon.
 */
const iconsByLabel = new Map<string, Icon>([
    [toolbar.bold.tooltip, TextBIcon],
    [toolbar.italic.tooltip, TextItalicIcon],
    [toolbar.underline.tooltip, TextUnderlineIcon],
    [toolbar.strike.tooltip, TextStrikethroughIcon],
    [toolbar.code.tooltip, CodeIcon],
    [toolbar.align_left.tooltip, TextAlignLeftIcon],
    [toolbar.align_center.tooltip, TextAlignCenterIcon],
    [toolbar.align_right.tooltip, TextAlignRightIcon],
    [toolbar.align_justify.tooltip, TextAlignJustifyIcon],
    [toolbar.nest.tooltip, TextIndentIcon],
    [toolbar.unnest.tooltip, TextOutdentIcon],
    [toolbar.link.tooltip, LinkIcon],
    // The caption and rename fields use their buttons' labels as placeholders.
    [toolbar.file_caption.tooltip, SubtitlesIcon],
    [toolbar.file_preview_toggle.tooltip, EyeIcon],
    ...fileTypes(toolbar.file_replace.tooltip, SwapIcon),
    ...fileTypes(toolbar.file_rename.tooltip, TextAaIcon),
    ...fileTypes(toolbar.file_download.tooltip, DownloadSimpleIcon),
    ...fileTypes(toolbar.file_delete.tooltip, TrashIcon),
    [en.link_toolbar.open.tooltip, ArrowSquareOutIcon],
    [en.link_toolbar.delete.tooltip, LinkBreakIcon],
    [en.link_toolbar.form.url_placeholder, LinkIcon],
    [en.link_toolbar.form.title_placeholder, TextTIcon],
    [en.side_menu.drag_handle_label, DotsSixVerticalIcon],
])

/** A skin component with the Phosphor icon for its label in place of BlockNote's. */
function withPhosphor<P extends {icon?: ReactNode}>(
    Base: ComponentType<P>,
    labelOf: (props: P) => string | undefined,
): ComponentType<P> {
    return function PhosphorIcon(props: P) {
        const LabelIcon = props.icon ? iconsByLabel.get(labelOf(props) ?? '') : undefined
        const next: P = LabelIcon ? {...props, icon: <LabelIcon/>} : props
        return <Base {...next}/>
    }
}

/** Ariakit's components, with Phosphor icons in the buttons and fields that take one. */
export const notesComponents: Components = {
    ...ariakit,
    FormattingToolbar: {
        ...ariakit.FormattingToolbar,
        Button: withPhosphor(ariakit.FormattingToolbar.Button, (props) => props.label),
    },
    LinkToolbar: {
        ...ariakit.LinkToolbar,
        Button: withPhosphor(ariakit.LinkToolbar.Button, (props) => props.label),
    },
    SideMenu: {
        ...ariakit.SideMenu,
        Button: withPhosphor(ariakit.SideMenu.Button, (props) => props.label),
    },
    Generic: {
        ...ariakit.Generic,
        Form: {
            ...ariakit.Generic.Form,
            TextInput: withPhosphor(ariakit.Generic.Form.TextInput, (props) => props.placeholder),
        },
    },
}
