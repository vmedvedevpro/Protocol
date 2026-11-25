import {BlockNoteEditor} from '@blocknote/core'
import {blockTypeSelectItems, getDefaultReactSlashMenuItems} from '@blocknote/react'
import {describe, expect, it} from 'vitest'
import {formatBadge, slashMenuItems, withBlockTypeIcons} from './editorIcons'

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

    it('writes the slash menu badges as the app writes shortcuts', () => {
        expect(formatBadge('Ctrl-Alt-1', 'windows')).toBe('Ctrl Alt 1')
        expect(formatBadge('Ctrl-Shift-8', 'linux')).toBe('Ctrl Shift 8')
        expect(formatBadge('Ctrl-Alt-c', 'windows')).toBe('Ctrl Alt C')
        expect(formatBadge('⌘-Alt-1', 'macos')).toBe('⌘⌥1')
        expect(formatBadge('Ctrl-Shift-9', 'macos')).toBe('⌘⇧9')

        const heading = slashMenuItems(editor).find((item) => item.title === 'Heading 1')
        expect(heading?.badge).toBe(formatBadge('Ctrl-Alt-1'))
    })

    it('replaces the icon of every block type', () => {
        const theirs = blockTypeSelectItems(editor)
        const ours = withBlockTypeIcons(theirs)

        ours.forEach((item, i) => expect(item.icon, item.name).not.toBe(theirs[i].icon))
    })
})
