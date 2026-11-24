import {BlockNoteEditor} from '@blocknote/core'
import {blockTypeSelectItems, getDefaultReactSlashMenuItems} from '@blocknote/react'
import {describe, expect, it} from 'vitest'
import {slashMenuItems, withBlockTypeIcons} from './editorIcons'

// A BlockNote upgrade that adds an item, or renames one, would bring back
// one of its own icons; these fail then.
describe('editor icons', () => {
    const editor = BlockNoteEditor.create()

    it('replaces the icon of every slash menu item', () => {
        const theirs = getDefaultReactSlashMenuItems(editor)
        const ours = slashMenuItems(editor)

        expect(ours.map((item) => item.title)).toEqual(theirs.map((item) => item.title))
        ours.forEach((item, i) => {
            expect(item.icon?.type, item.title).toBeDefined()
            expect(item.icon?.type, item.title).not.toBe(theirs[i].icon?.type)
        })
    })

    it('replaces the icon of every block type', () => {
        const theirs = blockTypeSelectItems(editor)
        const ours = withBlockTypeIcons(theirs)

        ours.forEach((item, i) => expect(item.icon, item.name).not.toBe(theirs[i].icon))
    })
})
