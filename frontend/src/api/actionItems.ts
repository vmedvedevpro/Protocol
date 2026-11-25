/**
 * A meeting's action items: rows of their own (action_item.rs), checked off,
 * reworded, owned and dated, so the summary does not repeat them. A new
 * summary's action section moves into them (features/meetings/lib/
 * actionItemSync.ts); the user adds their own. Person (#118) and search
 * (#118) list them too.
 */
import {mutationOptions, type QueryClient, queryOptions} from '@tanstack/react-query'
import {command} from './core'

/** Mirrors `ActionItemView` in action_item.rs. */
export interface ActionItem {
    id: string
    meetingId: string
    meetingTitle: string
    meetingCreatedAt: string
    groupId?: string
    text: string
    /** Who owns it as the summary or the user wrote it ("Priya Shah", "You"). */
    ownerLabel?: string
    /** The contact native matched the owner to. */
    personId?: string
    personName?: string
    /** As written: "Friday", "next week". */
    dueText?: string
    done: boolean
    doneAt?: string
    /** `ai`: from a summary; `user`: added by hand. */
    source: 'ai' | 'user'
    /** Changed by the user, so a new summary does not replace it. */
    edited: boolean
    /** Where in the recording it was said, in seconds. */
    audioTime?: number
    transcriptId?: string
    position: number
    createdAt: string
    updatedAt: string
}

/** What a new item, or an item from a summary, carries; mirrors `ActionItemDraft`. */
export interface ActionItemDraft {
    text: string
    ownerLabel?: string | null
    dueText?: string | null
    audioTime?: number | null
    transcriptId?: string | null
}

export interface ActionItemFilter {
    meetingId?: string
    personId?: string
    groupId?: string
    openOnly?: boolean
    limit?: number
}

export const actionItemKeys = {
    all: ['actionItems'] as const,
    list: (filter: ActionItemFilter) => [...actionItemKeys.all, 'list', filter] as const,
}

export const getActionItems = (filter: ActionItemFilter) =>
    command<ActionItem[]>('api_list_action_items', {
        meetingId: filter.meetingId ?? null,
        personId: filter.personId ?? null,
        groupId: filter.groupId ?? null,
        openOnly: filter.openOnly ?? false,
        limit: filter.limit ?? null,
    })

export const createActionItem = (meetingId: string, draft: ActionItemDraft) =>
    command<ActionItem>('api_create_action_item', {
        meetingId,
        text: draft.text,
        ownerLabel: draft.ownerLabel ?? null,
        personId: null,
        dueText: draft.dueText ?? null,
        audioTime: draft.audioTime ?? null,
        transcriptId: draft.transcriptId ?? null,
    })

/** Writes the whole item back: native replaces text, owner, due date and done together. */
export const updateActionItem = (item: ActionItem) =>
    command<ActionItem>('api_update_action_item', {
        id: item.id,
        text: item.text,
        ownerLabel: item.ownerLabel ?? null,
        personId: item.personId ?? null,
        dueText: item.dueText ?? null,
        done: item.done,
    })

export const deleteActionItem = (id: string) => command<null>('api_delete_action_item', {id})

/**
 * Replaces a meeting's items from its summary with `items`, keeping those
 * the user changed or added, and remembers `sourceFingerprint` (the summary
 * the items came from) so the same summary is not read twice.
 */
export const syncSummaryActionItems = (meetingId: string, items: ActionItemDraft[], sourceFingerprint: string) =>
    command<ActionItem[]>('api_sync_ai_action_items', {meetingId, items, sourceFingerprint})

/** Meetings whose summary was never read for action items (summarized by older versions). */
export const getUnsyncedActionMeetings = () => command<string[]>('api_list_unsynced_action_meetings')

export const actionItemsQuery = (filter: ActionItemFilter) =>
    queryOptions({
        queryKey: actionItemKeys.list(filter),
        queryFn: () => getActionItems(filter),
    })

const invalidateItems = {
    onSuccess: (_reply: unknown, _variables: unknown, _result: unknown, {client}: { client: QueryClient }) =>
        client.invalidateQueries({queryKey: actionItemKeys.all}),
}

export const updateActionItemMutation = mutationOptions({mutationFn: updateActionItem, ...invalidateItems})

export const createActionItemMutation = (meetingId: string) =>
    mutationOptions({mutationFn: (draft: ActionItemDraft) => createActionItem(meetingId, draft), ...invalidateItems})

export const deleteActionItemMutation = mutationOptions({mutationFn: deleteActionItem, ...invalidateItems})

/**
 * Rewrites a summary the app changed itself, such as moving its action items
 * into their own list; native keeps the user-edited flag as it was.
 */
export const saveSummaryBySystem = (meetingId: string, summary: Record<string, unknown>) =>
    command<unknown>('api_save_meeting_summary', {meetingId, summary, userEdit: false})
