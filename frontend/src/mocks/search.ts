import type {SearchResult} from '@/features/search/api/search'
import type {MockHandler} from './handlers'
import type {MockMeetings} from './meetings'
import type {MockPeople} from './people'

/**
 * `api_global_search` over the mock library, with native's shapes and
 * ranking (meeting-library's search.rs): an exact name or title first, then
 * a prefix, then the rest; a line whose speaker matches before one whose
 * text does, then summaries; newest first within a rank.
 * Matching is case-blind and on the text as written, as native's
 * `unicode_lower` LIKE is.
 */

interface Ranked {
    score: number
    time: string
    result: SearchResult
}

const quality = (value: string, query: string) => (value === query ? 0 : value.startsWith(query) ? 3 : 10)

/** As native's `snippet_around`: the match a third of the way in, "..." where cut. */
function snippetAround(text: string, query: string, max: number): string {
    const chars = [...text]
    if (chars.length <= max) return text
    const lower = text.toLowerCase()
    const found = lower.indexOf(query)
    const at = found < 0 ? 0 : [...lower.slice(0, found)].length
    const start = Math.max(0, at - Math.floor(max / 3))
    const end = Math.min(chars.length, start + max)
    return `${start > 0 ? '...' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '...' : ''}`
}

/** The words a summary shows, whatever format it was stored in (native's `visible_summary_text`). */
function visibleText(data: unknown): string {
    if (typeof data === 'string') {
        try {
            return visibleText(JSON.parse(data))
        } catch {
            return data
        }
    }
    if (Array.isArray(data)) return data.map(visibleText).filter(Boolean).join('\n')
    if (data && typeof data === 'object') {
        return Object.entries(data)
            .filter(([key]) => !key.startsWith('_') && !['id', 'type', 'color'].includes(key))
            .map(([, value]) => visibleText(value))
            .filter(Boolean)
            .join('\n')
    }
    return ''
}

export function searchHandlers(state: { meetings: MockMeetings, people: MockPeople }): Record<string, MockHandler> {
    return {
        api_global_search: ({query, limit}) => {
            const needle = String(query ?? '').trim().toLowerCase()
            if (!needle) return []
            const db = state.meetings
            const ranked: Ranked[] = []
            const spokeIn = (name: string) => new Set(Object.entries(db.transcripts)
                .filter(([, lines]) => lines.some((line) => line.speaker?.trim().toLowerCase() === name.toLowerCase()))
                .map(([meetingId]) => meetingId)).size

            for (const person of state.people.rows) {
                const name = person.displayName.toLowerCase()
                if (!name.includes(needle)) continue
                const meetingCount = spokeIn(person.displayName)
                ranked.push({
                    score: quality(name, needle),
                    time: '',
                    result: {
                        kind: 'person', id: person.id, personId: person.id, title: person.displayName,
                        snippet: person.notes ?? `${meetingCount} mapped meetings`, meetingCount,
                    },
                })
            }
            for (const meeting of db.meetings) {
                const title = meeting.title.toLowerCase()
                if (title.includes(needle)) {
                    ranked.push({
                        score: quality(title, needle),
                        time: meeting.created_at,
                        result: {kind: 'meeting', id: meeting.id, meetingId: meeting.id, title: meeting.title, snippet: meeting.title, timestamp: meeting.created_at},
                    })
                }
                for (const line of db.transcripts[meeting.id] ?? []) {
                    const bySpeaker = (line.speaker ?? '').toLowerCase().includes(needle)
                    if (!bySpeaker && !line.text.toLowerCase().includes(needle)) continue
                    const result: SearchResult = {
                        kind: 'transcript', id: line.id, meetingId: meeting.id, transcriptId: line.id, title: meeting.title,
                        snippet: snippetAround(line.text, needle, 180), timestamp: line.timestamp,
                    }
                    if (line.speaker) result.speaker = line.speaker
                    if (line.audio_start_time != null) result.audioStartTime = line.audio_start_time
                    ranked.push({score: bySpeaker ? 5 : 20, time: line.timestamp, result})
                }
                const summary = visibleText(db.summaries[meeting.id]?.data)
                if (summary.toLowerCase().includes(needle)) {
                    ranked.push({
                        score: 25,
                        time: meeting.created_at,
                        result: {
                            kind: 'summary', id: `summary-${meeting.id}`, meetingId: meeting.id, title: meeting.title,
                            snippet: snippetAround(summary, needle, 220), timestamp: meeting.created_at,
                        },
                    })
                }
            }
            for (const folder of db.folders) {
                const name = folder.name.toLowerCase()
                if (!name.includes(needle)) continue
                const meetingCount = db.meetings.filter((meeting) => meeting.group_id === folder.id).length
                const result: SearchResult = {
                    kind: 'group', id: folder.id, groupId: folder.id, title: folder.name,
                    snippet: `${meetingCount} meeting${meetingCount === 1 ? '' : 's'}`, meetingCount,
                }
                if (folder.color) result.color = folder.color
                ranked.push({score: quality(name, needle) + 1, time: '', result})
            }
            ranked.sort((a, b) => a.score - b.score || b.time.localeCompare(a.time) || a.result.id.localeCompare(b.result.id))
            return ranked.slice(0, typeof limit === 'number' ? Math.min(limit, 100) : 40).map((entry) => entry.result)
        },
    }
}
