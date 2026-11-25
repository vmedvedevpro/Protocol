import {css, keyframes} from 'styled-components'
import {
    colorTransition,
    fieldFocusRing,
    focusRing,
    keyboardRowRing,
    popoverItem,
    popoverSurface,
} from '@/components/ui/styles'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MOTION_OK, SCALE_FROM} from '@/styles/motion'

// The icons in BlockNote's buttons and menu rows (Phosphor, editorIcons) take
// the app's icon size whatever size BlockNote asks for.
const ICON_SIZE = `${ICON_DEFAULTS.size}px`

// The slash menu and the emoji picker scroll past this height: in the 460 ×
// 700 window that leaves room for the line they open from and a margin on
// either side. Where there is less room, BlockNote caps them to it.
const MENU_MAX_HEIGHT = '320px'

const placeholderIn = keyframes`
    from {
        opacity: 0;
    }
`

// The fade comes from BlockNote's popover (over `fast`, NotesEditorView);
// this adds the scale that menus and popovers open with.
const menuIn = keyframes`
    from {
        transform: scale(${SCALE_FROM});
    }
`

/**
 * The notes and BlockNote's menus, from the theme. BlockNote gives the editor
 * and each of its menu layers (on <body>) the same class, so these rules reach
 * both. Its stylesheets arrive with the editor's chunk, in an order against
 * styled-components' that is not fixed, and their rules go up to two classes
 * and an attribute deep: every rule here starts with `&&&` (this class three
 * times) and wins either way. BlockNote also sets a light or dark palette on
 * .bn-root; only its highlight colours stay, for notes the old app saved with
 * text colours.
 */
export const editorStyles = css`
    &&& {
        --bn-font-family: ${({theme}) => theme.fonts.sans};
        --bn-colors-editor-text: ${({theme}) => theme.colors.text};
        --bn-colors-editor-background: transparent;
        --bn-colors-menu-text: ${({theme}) => theme.colors.text};
        --bn-colors-menu-background: ${({theme}) => theme.colors.raised};
        --bn-colors-tooltip-text: ${({theme}) => theme.colors.text};
        --bn-colors-tooltip-background: ${({theme}) => theme.colors.raised};
        --bn-colors-hovered-text: ${({theme}) => theme.colors.text};
        --bn-colors-hovered-background: ${({theme}) => theme.colors.surface};
        --bn-colors-selected-text: ${({theme}) => theme.colors.text};
        --bn-colors-selected-background: ${({theme}) => theme.colors.surface};
        --bn-colors-disabled-text: ${({theme}) => theme.colors.muted};
        --bn-colors-disabled-background: ${({theme}) => theme.colors.surface};
        --bn-colors-border: ${({theme}) => theme.colors.border};
        --bn-colors-side-menu: ${({theme}) => theme.colors.muted};
        --bn-colors-shadow: transparent;
        --bn-border-radius: ${({theme}) => theme.radii.md};
        font-family: ${({theme}) => theme.fonts.sans};
        color: ${({theme}) => theme.colors.text};
    }

    /* ---- The notes ---- */

    &&&.bn-container {
        display: flex;
        flex: 1;
        flex-direction: column;
    }

    /* The host pads the panel. BlockNote's inline padding is room for a side
       menu of two buttons; ours is the drag handle alone, in the host's gutter. */
    &&& .bn-editor {
        flex: 1;
        padding-inline: 0;
    }

    &&& .bn-default-styles {
        font-family: ${({theme}) => theme.fonts.sans};
        ${({theme}) => theme.text.notes};
    }

    /* Lines follow each other at the notes' line height, as in the design. */
    &&& .bn-block-outer {
        line-height: inherit;
        transition: none;
    }

    &&& .bn-block-content,
    &&& .bn-block-content::before {
        padding-block: 0;
        transition: none;
    }

    &&& .bn-block-group .bn-block-group {
        margin-left: ${({theme}) => theme.space[5]};
    }

    &&& .bn-block-content[data-content-type='heading'] {
        --level: 1em;
        --prev-level: 1em;
        padding-top: ${({theme}) => theme.space[3]};
    }

    &&& .bn-block-group > .bn-block-outer:first-child .bn-block-content[data-content-type='heading'] {
        padding-top: 0;
    }

    &&& .bn-block-content[data-content-type='heading'] .bn-inline-content {
        ${({theme}) => theme.text.notes};
        font-weight: ${({theme}) => theme.fontWeights.semibold};
    }

    &&& .bn-block-content[data-content-type='heading'][data-level='1'] .bn-inline-content {
        ${({theme}) => theme.text.notesHeading};
    }

    /* Markers take the indent of a nested list, so children line up with the text. */
    &&& .bn-block-content[data-content-type='bulletListItem']::before,
    &&& .bn-block-content[data-content-type='numberedListItem']::before {
        min-width: ${({theme}) => theme.space[5]};
        padding-right: 0;
    }

    &&& .bn-block-content[data-content-type='checkListItem'] > div:has(> input) {
        height: ${({theme}) => theme.text.notes.lineHeight};
    }

    &&& .bn-block-content[data-content-type='checkListItem'] > div > input {
        height: ${({theme}) => theme.text.notes.lineHeight};
        margin: 0 ${({theme}) => theme.space[1.5]} 0 ${({theme}) => theme.space[0.5]};
        accent-color: ${({theme}) => theme.colors.text};
    }

    &&& .bn-block-content[data-content-type='checkListItem'] .bn-inline-content {
        transition: color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    &&& .bn-block-content[data-content-type='checkListItem'][data-checked='true'] .bn-inline-content {
        color: ${({theme}) => theme.colors.muted};
    }

    &&& .bn-block-content[data-content-type='quote'] blockquote {
        padding-left: ${({theme}) => theme.space[3]};
        border-left: 2px solid ${({theme}) => theme.colors.border};
        color: ${({theme}) => theme.colors.soft};
    }

    &&& .bn-inline-content code {
        padding: 0 ${({theme}) => theme.space[1]};
        border-radius: ${({theme}) => theme.radii.xs};
        background: ${({theme}) => theme.colors.surface};
        font-family: ${({theme}) => theme.fonts.mono};
    }

    &&& .bn-block-content[data-content-type='codeBlock'] {
        margin-block: ${({theme}) => theme.space[1]};
        border-radius: ${({theme}) => theme.radii.md};
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }

    &&& .bn-block-content[data-content-type='codeBlock'] > pre {
        padding: ${({theme}) => theme.space[3]};
        font-family: ${({theme}) => theme.fonts.mono};
        ${({theme}) => theme.text.body};
    }

    &&& .bn-block-content[data-content-type='codeBlock'] > div > select {
        color: ${({theme}) => theme.colors.muted};
    }

    /* BlockNote draws cell borders in a fixed light grey. */
    &&& .bn-block-content[data-content-type='table'] :is(th, td) {
        border-color: ${({theme}) => theme.colors.border};
    }

    &&& .bn-editor a {
        color: inherit;
        text-decoration: underline;
        text-decoration-color: ${({theme}) => theme.colors.muted};
        text-underline-offset: ${({theme}) => theme.space[0.5]};
    }

    /* The placeholder fades in each time a line becomes empty. */
    &&& .bn-block-content:has(.ProseMirror-trailingBreak:only-child)::after {
        color: ${({theme}) => theme.colors.muted};
        font-style: normal;
        animation: ${placeholderIn} ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.enter};
    }

    /* ---- Menus: the formatting toolbar, the slash menu, the emoji picker,
       the link toolbar, the file panel and the menus they open. They share
       the surface, rows, buttons and fields of the app's own menus and
       controls (src/components/ui). ---- */

    &&& .bn-ak-toolbar,
    &&& .bn-ak-menu,
    &&& .bn-ak-popover,
    &&& .bn-suggestion-menu,
    &&& .bn-frimousse-picker,
    &&& .bn-panel {
        ${popoverSurface};
        ${({theme}) => theme.text.small};
        transform-origin: top left;
    }

    /* Each button has an empty tooltip holder after it, so a gap would count
       twice. In a window narrower than the toolbar its buttons wrap; Ariakit's
       own overflow: scroll draws scrollbars on Linux and Windows. */
    &&& .bn-ak-toolbar {
        flex-wrap: wrap;
        gap: 0;
        max-width: calc(100vw - ${({theme}) => theme.space[4]});
        overflow: visible;
        transform-origin: bottom left;
    }

    &&& .bn-suggestion-menu {
        max-height: ${MENU_MAX_HEIGHT};
    }

    &&& .bn-frimousse-picker {
        height: ${MENU_MAX_HEIGHT};
    }

    &&& .bn-frimousse-picker [frimousse-search] {
        border-radius: ${({theme}) => theme.radii.sm};
        ${({theme}) => theme.text.small};
    }

    /* Category names read like the slash menu's group labels. */
    &&& .bn-frimousse-picker [frimousse-category-header] {
        color: ${({theme}) => theme.colors.muted};
        ${({theme}) => theme.text.caption};
        font-weight: ${({theme}) => theme.fontWeights.medium};
    }

    ${MOTION_OK} {
        &&& .bn-ak-toolbar,
        &&& .bn-ak-menu,
        &&& .bn-ak-popover,
        &&& .bn-suggestion-menu,
        &&& .bn-frimousse-picker,
        &&& .bn-panel {
            animation: ${menuIn} ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.enter};
        }
    }

    &&& .bn-ak-separator {
        border-color: ${({theme}) => theme.colors.border};
    }

    &&& .bn-ak-toolbar .bn-ak-separator {
        height: ${({theme}) => theme.space[5]};
        margin: 0 ${({theme}) => theme.space[0.5]};
    }

    &&& .bn-ak-menu .bn-ak-separator {
        margin: ${({theme}) => theme.space[1]} 0;
    }

    /* Buttons in the toolbar and the side menu press like the app's buttons:
       colour and background change on hover, a press scales them down. The
       table's handles and extend buttons keep BlockNote's sizes, which the
       table leaves room for. */
    &&& .bn-ak-button:not(.bn-table-handle, .bn-table-cell-handle, .bn-extend-button) {
        height: ${({theme}) => theme.sizes.control.sm};
        min-width: ${({theme}) => theme.sizes.control.sm};
        padding: 0 ${({theme}) => theme.space[1.5]};
    }

    &&& .bn-ak-button {
        border: 0;
        border-radius: ${({theme}) => theme.radii.sm};
        background: transparent;
        color: ${({theme}) => theme.colors.soft};
        box-shadow: none;
        ${({theme}) => theme.text.label};
        ${colorTransition};
        ${focusRing};
    }

    &&& .bn-ak-button:hover,
    &&& .bn-ak-button[aria-expanded='true'] {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }

    &&& .bn-ak-button[data-selected] {
        padding-top: 0;
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
        box-shadow: none;
    }

    &&& .bn-ak-button:active,
    &&& .bn-ak-button[data-active] {
        padding-top: 0;
        box-shadow: none;
    }

    ${MOTION_OK} {
        &&& .bn-ak-button {
            transition-property: color, background-color, border-color, transform;
        }

        &&& .bn-ak-button:active {
            transform: scale(${SCALE_FROM});
        }
    }

    &&& .bn-ak-button svg {
        width: ${ICON_SIZE};
        height: ${ICON_SIZE};
    }

    /* Menu rows: the slash menu, the block type and colour menus, the drag
       handle's menu. They are the app's menu rows, except that the row the
       pointer or the keyboard picked fills itself: the app's sliding
       highlight is a Radix menu's. Only that row fills, never the one under
       the pointer as well: Ariakit's menus pick the hovered row themselves,
       and the slash menu's pick is the row Enter inserts. Ariakit's lists
       are flex columns that scroll, so the rows keep their height instead of
       shrinking to fit. */
    &&& .bn-ak-menu-item,
    &&& .bn-ak-select-item {
        ${popoverItem};
        flex-shrink: 0;
        background: transparent;
    }

    &&& .bn-ak-menu-item[data-active-item],
    &&& .bn-ak-menu-item[aria-selected='true'],
    &&& .bn-ak-menu-item[aria-expanded='true'],
    &&& .bn-ak-select-item[data-active-item] {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }

    /* The keyboard's row also gets the app's row ring (popoverItem): Ariakit
       marks it data-focus-visible, and the slash menu's pick moves only by
       the keyboard (its arrows, or typing). */
    &&& .bn-ak-menu-item[data-focus-visible],
    &&& .bn-ak-select-item[data-focus-visible],
    &&& .bn-suggestion-menu-item[aria-selected='true'] {
        ${keyboardRowRing};
    }

    /* A slash menu row also has a line that says what the block is. */
    &&& .bn-suggestion-menu-item {
        height: auto;
        min-height: ${({theme}) => theme.sizes.control.sm};
        padding-block: ${({theme}) => theme.space[1]};
    }

    &&& .bn-ak-group-label {
        padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[1]};
        color: ${({theme}) => theme.colors.muted};
        opacity: 1;
        ${({theme}) => theme.text.caption};
        font-weight: ${({theme}) => theme.fontWeights.medium};
    }

    /* An item's icon is muted beside its text, as in the app's menus. */
    &&& .bn-ak-suggestion-menu-item-section[data-position='left'] {
        padding: 0;
        color: ${({theme}) => theme.colors.muted};
    }

    &&& .bn-ak-suggestion-menu-item-section[data-position='left'] svg {
        width: ${ICON_SIZE};
        height: ${ICON_SIZE};
    }

    &&& .bn-ak-suggestion-menu-item-title {
        ${({theme}) => theme.text.body};
    }

    &&& .bn-ak-suggestion-menu-item-subtitle {
        color: ${({theme}) => theme.colors.muted};
        ${({theme}) => theme.text.caption};
    }

    /* A shortcut, as the app's Kbd draws one on a surface. */
    &&& .bn-ak-suggestion-menu-item-section[data-position='right'] {
        padding: 1px ${({theme}) => theme.space[1.5]};
        border-radius: ${({theme}) => theme.radii.xs};
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.muted};
        box-shadow: none;
        font-family: inherit;
        ${({theme}) => theme.text.caption};
    }

    /* Inverted, as the app's Tooltip. */
    &&& .bn-ak-tooltip {
        padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2]};
        border: 0;
        border-radius: ${({theme}) => theme.radii.sm};
        background: ${({theme}) => theme.colors.text};
        color: ${({theme}) => theme.colors.bg};
        box-shadow: ${({theme}) => theme.shadows.popover};
        ${({theme}) => theme.text.small};
    }

    /* The link form's fields, as the app's small outlined TextField. */
    &&& .bn-ak-input {
        height: ${({theme}) => theme.sizes.control.sm};
        padding: 0 ${({theme}) => theme.space[2]};
        border: 1px solid ${({theme}) => theme.colors.border};
        border-radius: ${({theme}) => theme.radii.sm};
        background: ${({theme}) => theme.colors.raised};
        color: ${({theme}) => theme.colors.text};
        box-shadow: none;
        ${({theme}) => theme.text.label};
        font-weight: ${({theme}) => theme.fontWeights.regular};
        ${colorTransition};
    }

    &&& .bn-ak-input:hover {
        border-color: ${({theme}) => theme.colors.muted};
    }

    &&& .bn-ak-input:focus,
    &&& .bn-ak-input[data-focus-visible] {
        border-color: ${({theme}) => theme.colors.text};
        ${fieldFocusRing};
    }

    &&& .bn-ak-input::placeholder {
        color: ${({theme}) => theme.colors.muted};
        opacity: 1;
    }

    /* A field's icon is muted, as in the app's TextField. */
    &&& .bn-ak-input-wrapper > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }

    /* ---- The drag handle, alone in the host's 20 px gutter, and the table's handles ---- */

    &&& .bn-table-handle,
    &&& .bn-table-cell-handle,
    &&& .bn-extend-button {
        color: ${({theme}) => theme.colors.muted};
    }

    &&& .bn-side-menu {
        margin-right: ${({theme}) => theme.space[1]};
    }

    &&& .bn-side-menu .bn-ak-button {
        width: ${({theme}) => theme.space[4]};
        min-width: 0;
        height: ${({theme}) => theme.text.notes.lineHeight};
        padding: 0;
        border-radius: ${({theme}) => theme.radii.xs};
        color: ${({theme}) => theme.colors.muted};
        cursor: grab;
    }

    &&& .bn-side-menu .bn-ak-button:hover,
    &&& .bn-side-menu .bn-ak-button[aria-expanded='true'] {
        color: ${({theme}) => theme.colors.text};
    }

    &&& .bn-side-menu .bn-ak-button:active {
        cursor: grabbing;
    }
`

/**
 * The summary's editor (NotesEditor `variant="summary"`): every heading is
 * a section label like Action items under it, and the empty line BlockNote
 * keeps at the end takes no room until the editor has focus, so the gap
 * before the action items is the sections' own. One more `&` than
 * editorStyles, which it follows.
 */
export const summaryEditorStyles = css`
    &&&& .bn-block-content[data-content-type='heading'] .bn-inline-content {
        ${({theme}) => theme.text.small};
        font-weight: ${({theme}) => theme.fontWeights.semibold};
        color: ${({theme}) => theme.colors.muted};
    }

    &&&& .bn-block-content[data-content-type='heading'] {
        padding-top: ${({theme}) => theme.space[5]};
    }

    &&&& .bn-block-group > .bn-block-outer:first-child .bn-block-content[data-content-type='heading'] {
        padding-top: 0;
    }

    &&&&:not(:focus-within) .bn-editor > .bn-block-group > .bn-block-outer:last-child:not(:first-child):has(.ProseMirror-trailingBreak:only-child) {
        display: none;
    }
`
