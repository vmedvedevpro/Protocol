/**
 * Starts loading the editor's chunk (BlockNote, ProseMirror and their CSS).
 * `NotesEditor` calls it on its first render; a screen that is about to show
 * one can call it earlier, so the editor is there when the tab opens.
 */
export const loadNotesEditor = () => import('./NotesEditorView')
