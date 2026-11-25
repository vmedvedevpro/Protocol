import {create} from 'zustand'

/** Summary options: write the summary again; `templateId` starts on that template instead of the default. */
interface SummaryOptionsRequest {
    kind: 'summary'
    meetingId: string
    templateId?: string
}

/**
 * The dialogs that open over a screen (#119), and what each needs to open.
 * They live in features/dialogs, which no feature imports; a screen opens
 * one here, as it navigates with `paths`, and the shell's `DialogHost`
 * shows it.
 */
export type DialogRequest =
    /** Import a recording; `path` is a file dropped on the window, checked as it opens. */
    | { kind: 'import', path?: string }
    | { kind: 'export', meetingId: string }
    /** Enhance transcript: retranscribe the meeting's audio with a chosen model. */
    | { kind: 'enhance', meetingId: string }
    | SummaryOptionsRequest
    /**
     * The template editor: edit `templateId`, or a new template without one.
     * `returnTo` reopens Summary options as the editor closes, on the
     * template it saved.
     */
    | { kind: 'template', templateId?: string, returnTo?: SummaryOptionsRequest }

export type DialogKind = DialogRequest['kind']

type RequestOf<K extends DialogKind> = Extract<DialogRequest, { kind: K }>

/** A request as the host keeps it: `seq` tells one opening from the next, so its form starts afresh. */
export type OpenedDialog<K extends DialogKind = DialogKind> = RequestOf<K> & { seq: number }

interface DialogStore {
    /** The dialog on screen; one at a time. */
    open: DialogKind | null
    /**
     * Each dialog's last request, kept after it closes so its content stays
     * while its exit plays.
     */
    requests: { [K in DialogKind]?: OpenedDialog<K> }
}

const useDialogStore = create<DialogStore>(() => ({open: null, requests: {}}))

let seq = 0

/**
 * Opens a dialog over the screen, in place of the one open. Asked again
 * while it is open (a second file dropped on Import), it keeps its `seq`
 * and takes the new request, so its form carries on with it.
 */
export function openDialog(request: DialogRequest) {
    useDialogStore.setState(({open, requests}) => {
        const same = open === request.kind ? requests[request.kind]?.seq : undefined
        return {open: request.kind, requests: {...requests, [request.kind]: {...request, seq: same ?? ++seq}}}
    })
}

/** Closes `kind` if it is the one open, or whichever is open. */
export function closeDialog(kind?: DialogKind) {
    useDialogStore.setState(({open}) => (kind === undefined || open === kind ? {open: null} : {}))
}

/** Whether `kind` is on screen, and its last request (null before its first). */
export function useDialog<K extends DialogKind>(kind: K): { open: boolean, request: OpenedDialog<K> | null } {
    const open = useDialogStore((state) => state.open === kind)
    const request = useDialogStore((state) => (state.requests[kind] as OpenedDialog<K> | undefined) ?? null)
    return {open, request}
}

/** Tests and stories, between cases. */
export function resetDialogs() {
    useDialogStore.setState({open: null, requests: {}})
}
