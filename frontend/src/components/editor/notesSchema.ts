import {BlockNoteSchema, defaultBlockSpecs} from '@blocknote/core'

const checkListItem = defaultBlockSpecs.checkListItem
// BlockNote's own render, which every built-in block has.
const renderCheckListItem = checkListItem.implementation.render!

// Unique on the page, also with two editors showing the same notes.
let checkboxes = 0

/**
 * BlockNote's checklist item with a named checkbox. BlockNote renders a bare
 * `<input type="checkbox">` beside the item's text, which assistive technology
 * announces as an unnamed checkbox (axe "label"). Here the checkbox is named
 * by the item's text through `aria-labelledby`, so the name follows edits.
 * The config, and so the stored format, is BlockNote's.
 */
const namedCheckListItem: typeof checkListItem = {
    ...checkListItem,
    implementation: {
        ...checkListItem.implementation,
        render(block, editor) {
            // BlockNote calls render with its own `this`; it passes on.
            const rendered = renderCheckListItem.call(this, block, editor)
            const checkbox = rendered.dom instanceof Element || rendered.dom instanceof DocumentFragment
                ? rendered.dom.querySelector('input[type="checkbox"]')
                : null
            if (checkbox && rendered.contentDOM) {
                rendered.contentDOM.id = `notes-checklist-item-${++checkboxes}`
                checkbox.setAttribute('aria-labelledby', rendered.contentDOM.id)
            }
            return rendered
        },
    },
}

/** BlockNote's default blocks, with the checklist item above. */
export const notesSchema = BlockNoteSchema.create({
    blockSpecs: {...defaultBlockSpecs, checkListItem: namedCheckListItem},
})
