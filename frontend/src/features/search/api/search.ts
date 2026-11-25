/**
 * The library search behind ⌘K (`api_global_search`, person.rs, its queries
 * in meeting-library's search.rs, shared with the MCP server): one ranked
 * list of people, folders, meetings, transcript lines, summaries and action
 * items whose text contains the query.
 */
import {keepPreviousData, queryOptions} from '@tanstack/react-query'
import {command} from '@/api/core'

export type SearchResultKind = 'person' | 'group' | 'meeting' | 'transcript' | 'summary' | 'action'

/** Mirrors `GlobalSearchResult` in meeting-library's search.rs. */
export interface SearchResult {
    kind: SearchResultKind
    id: string
    meetingId?: string
    personId?: string
    transcriptId?: string
    /** The person's or folder's name, else the meeting's title. */
    title: string
    /**
     * A person's notes (or "N mapped meetings"), a folder's meeting count,
     * the line or summary around the match (with "..." where it was cut), an
     * action item's text, a meeting's title.
     */
    snippet: string
    /** The meeting's start for meetings, summaries and action items; the line's clock time for a line. */
    timestamp?: string
    /** Who said the line, or the action item's owner as written. */
    speaker?: string
    /** Where in the recording, in seconds. */
    audioStartTime?: number
    meetingCount?: number
    groupId?: string
    color?: string
}

/** Fewer characters than this find too much to be useful; the old dialog waited for two too. */
export const MIN_QUERY_LENGTH = 2

/** Native returns at most 100; the dialog shows 40, as before. */
const LIMIT = 40

export const searchKeys = {
    all: ['search'] as const,
    results: (query: string) => [...searchKeys.all, 'results', query] as const,
}

export const globalSearch = (query: string) => command<SearchResult[]>('api_global_search', {query, limit: LIMIT})

/**
 * The results for a trimmed query. While the next query's results load, the
 * last ones stay on screen (`placeholderData`), so typing does not empty the
 * list between words.
 */
export const searchQuery = (query: string) =>
    queryOptions({
        queryKey: searchKeys.results(query),
        queryFn: () => globalSearch(query),
        placeholderData: keepPreviousData,
        // The library changes under it (a rename, a new meeting); a cached
        // query is read again when the dialog opens with it.
        staleTime: 0,
    })
