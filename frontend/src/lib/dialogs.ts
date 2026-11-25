import {create} from 'zustand'

/** Summary options: write the summary again; `templateId` starts on that template instead of the default. */
interface SummaryOptionsRequest {
    kind: 'summary'
    meetingId: string
    templateId?: string
}

/**
 * Who said this line: the voice of a turn and its lines. A saved meeting's
 * `meetingId` changes the database; a recording's `live` renames the voice
 * in the session instead (features/recording owns how), with the lines it
 * shows.
 */
interface SpeakerRequest {
    kind: 'speaker'
    speaker: string
    lineIds: readonly string[]
    meetingId?: string
    live?: {
        lines: readonly { id: string, text: string, start: number | null, speaker?: string | null }[]
        rename: (from: string, to: string) => Promise<void>
    }
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
    | SpeakerRequest
    /**
     * Identify speakers: find the meeting's voices again from its audio,
     * with a count or detecting it. `identify` is the meeting screen's run
     * (features/meetings owns it, its toasts and its running state); the
     * sheet only asks for the count and confirms.
     */
    | { kind: 'identify-speakers', identify: (count: number | null) => void }
    /**
     * The template editor: edit `templateId`, or a new template without one.
     * `returnTo` reopens Summary options as the editor closes, on the
     * template it saved.
     */
    | { kind: 'template', templateId?: string, returnTo?: SummaryOptionsRequest }

export type DialogKind = DialogRequest['kind']

/** A request as the host keeps it: `seq` tells one opening from the next, so its form starts afresh. */
export type OpenedDialog = DialogRequest & { seq: number }

interface DialogStore {
    /**
     * The one dialog's request, kept after it closes so its content stays
     * while its exit plays; null before the first.
     */
    request: OpenedDialog | null
    open: boolean
}

const useDialogStore = create<DialogStore>(() => ({request: null, open: false}))

let seq = 0

/**
 * Opens a dialog over the screen, in place of the one open. Asked again
 * while it is open (a second file dropped on Import), it keeps its `seq`
 * and takes the new request, so its form carries on with it; any other
 * opening gets a new `seq`.
 */
export function openDialog(request: DialogRequest) {
    useDialogStore.setState(({request: current, open}) => {
        const same = open && current?.kind === request.kind
        return {open: true, request: {...request, seq: same ? current.seq : ++seq}}
    })
}

/** Closes `kind` if it is the one open, or whichever is open. */
export function closeDialog(kind?: DialogKind) {
    useDialogStore.setState(({request}) => (kind === undefined || request?.kind === kind ? {open: false} : {}))
}

/**
 * The dialog slot. A sheet narrows the request to its own kind
 * (`request?.kind === 'export' ? request : null`) and shows while `open`.
 */
export function useDialog(): DialogStore {
    const request = useDialogStore((state) => state.request)
    const open = useDialogStore((state) => state.open)
    return {request, open}
}

/** Tests and stories, between cases. */
export function resetDialogs() {
    useDialogStore.setState({request: null, open: false})
}
