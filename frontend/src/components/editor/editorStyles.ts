import {css, keyframes} from 'styled-components'
import {ICON_DEFAULTS} from '@/styles/icons'
import {MOTION_OK} from '@/styles/motion'

// BlockNote draws its own icons (react-icons); they take the app's icon size.
const ICON_SIZE = `${ICON_DEFAULTS.size}px`

const placeholderIn = keyframes`
    from {
        opacity: 0;
    }
`

// The fade comes from BlockNote's popover (over `fast`, NotesEditorView);
// this adds the scale from 0.96 that menus and popovers open with.
const menuIn = keyframes`
    from {
        transform: scale(0.96);
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
       the link toolbar, the file panel and the menus they open ---- */

    &&& .bn-ak-toolbar,
    &&& .bn-ak-menu,
    &&& .bn-ak-popover,
    &&& .bn-suggestion-menu,
    &&& .bn-frimousse-picker,
    &&& .bn-panel {
        border: 1px solid ${({theme}) => theme.colors.border};
        border-radius: ${({theme}) => theme.radii.md};
        background: ${({theme}) => theme.colors.raised};
        color: ${({theme}) => theme.colors.text};
        box-shadow: ${({theme}) => theme.shadows.popover};
        ${({theme}) => theme.text.small};
    }

    /* Each button has an empty tooltip holder after it, so a gap would count
       twice. In a window narrower than the toolbar its buttons wrap; Ariakit's
       own overflow: scroll draws scrollbars on Linux and Windows. */
    &&& .bn-ak-toolbar {
        flex-wrap: wrap;
        gap: 0;
        max-width: calc(100vw - ${({theme}) => theme.space[4]});
        padding: ${({theme}) => theme.space[1]};
        overflow: visible;
        transform-origin: bottom left;
    }

    &&& .bn-ak-menu,
    &&& .bn-ak-popover,
    &&& .bn-suggestion-menu,
    &&& .bn-frimousse-picker,
    &&& .bn-panel {
        padding: ${({theme}) => theme.space[1]};
        transform-origin: top left;
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

    /* Buttons in the toolbar and the side menu: colour and background change
       on hover, and a press scales to 0.96. */
    &&& .bn-ak-button {
        height: ${({theme}) => theme.sizes.control.sm};
        min-width: ${({theme}) => theme.sizes.control.sm};
        padding: 0 ${({theme}) => theme.space[1.5]};
        border: 0;
        border-radius: ${({theme}) => theme.radii.sm};
        background: transparent;
        color: ${({theme}) => theme.colors.soft};
        box-shadow: none;
        ${({theme}) => theme.text.label};
        transition:
            background-color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard},
            color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
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
            transition:
                background-color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard},
                color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard},
                transform ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
        }

        &&& .bn-ak-button:active {
            transform: scale(0.96);
        }
    }

    &&& .bn-ak-button[data-focus-visible],
    &&& .bn-ak-menu-item[data-focus-visible] {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: 1px;
    }

    &&& .bn-ak-button svg {
        width: ${ICON_SIZE};
        height: ${ICON_SIZE};
    }

    /* Menu rows: the slash menu, the block type and colour menus, the drag
       handle's menu. The row under the pointer or the keyboard is filled. */
    &&& .bn-ak-menu-item,
    &&& .bn-ak-select-item {
        min-height: ${({theme}) => theme.sizes.control.sm};
        padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2]};
        border-radius: ${({theme}) => theme.radii.sm};
        background: transparent;
        color: ${({theme}) => theme.colors.text};
        ${({theme}) => theme.text.label};
        font-weight: ${({theme}) => theme.fontWeights.regular};
        transition: background-color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    &&& .bn-ak-menu-item:hover,
    &&& .bn-ak-menu-item[data-active-item],
    &&& .bn-ak-menu-item[aria-selected='true'],
    &&& .bn-ak-menu-item[aria-expanded='true'],
    &&& .bn-ak-select-item[data-active-item] {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }

    &&& .bn-ak-menu-item:active,
    &&& .bn-ak-menu-item[data-active] {
        padding-block: ${({theme}) => theme.space[1]};
        background: ${({theme}) => theme.colors.surface};
    }

    &&& .bn-ak-group-label {
        padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[1]};
        color: ${({theme}) => theme.colors.muted};
        opacity: 1;
        ${({theme}) => theme.text.caption};
        font-weight: ${({theme}) => theme.fontWeights.medium};
    }

    &&& .bn-ak-suggestion-menu-item-section[data-position='left'] {
        width: ${({theme}) => theme.sizes.control.sm};
        height: ${({theme}) => theme.sizes.control.sm};
        padding: 0;
        border: 1px solid ${({theme}) => theme.colors.border};
        border-radius: ${({theme}) => theme.radii.sm};
        background: ${({theme}) => theme.colors.bg};
        color: ${({theme}) => theme.colors.soft};
    }

    &&& .bn-ak-suggestion-menu-item-section[data-position='left'] svg {
        width: ${ICON_SIZE};
        height: ${ICON_SIZE};
    }

    &&& .bn-ak-suggestion-menu-item-title {
        ${({theme}) => theme.text.label};
    }

    &&& .bn-ak-suggestion-menu-item-subtitle {
        color: ${({theme}) => theme.colors.muted};
        ${({theme}) => theme.text.caption};
    }

    &&& .bn-ak-suggestion-menu-item-section[data-position='right'] {
        padding: 0 ${({theme}) => theme.space[1]};
        border-radius: ${({theme}) => theme.radii.xs};
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.muted};
        box-shadow: none;
        font-family: ${({theme}) => theme.fonts.sans};
        ${({theme}) => theme.text.caption};
    }

    &&& .bn-ak-tooltip {
        padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2]};
        border: 1px solid ${({theme}) => theme.colors.border};
        border-radius: ${({theme}) => theme.radii.sm};
        background: ${({theme}) => theme.colors.raised};
        color: ${({theme}) => theme.colors.text};
        box-shadow: ${({theme}) => theme.shadows.popover};
        ${({theme}) => theme.text.small};
    }

    &&& .bn-ak-input {
        height: ${({theme}) => theme.sizes.control.sm};
        padding: 0 ${({theme}) => theme.space[2]};
        border: 1px solid ${({theme}) => theme.colors.border};
        border-radius: ${({theme}) => theme.radii.sm};
        background: ${({theme}) => theme.colors.bg};
        color: ${({theme}) => theme.colors.text};
        box-shadow: none;
        ${({theme}) => theme.text.small};
    }

    &&& .bn-ak-input::placeholder {
        color: ${({theme}) => theme.colors.muted};
    }

    &&& .bn-ak-input:focus-visible,
    &&& .bn-ak-input[data-focus-visible] {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: -1px;
    }

    /* ---- The drag handle, alone in the host's 20 px gutter ---- */

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
