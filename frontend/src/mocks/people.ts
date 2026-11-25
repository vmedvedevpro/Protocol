import type {TranscriptSegment} from '@/api/meetings'
import {
    isPersonLabel,
    normalizePersonName,
    type Person,
    type PersonDetails,
    type PersonFolder,
    type PersonMeeting,
    type PersonProfile,
    type VoiceProfile,
} from '@/api/people'
import type {MockHandler} from './handlers'
import type {MockLabs} from './labs'
import {meetingsHandlers, type MockMeetings, relabelSpeaker, required} from './meetings'

/**
 * Contacts and their voices, ported from the old browser preview
 * (`162e8be:frontend/src/dev/preview/fixtures.ts` and `index.ts`). Which
 * meetings a person spoke in is not stored here: as native's
 * `person_speakers`, it follows the transcripts, where a label with a
 * contact's name is theirs. Naming a voice (`rename_meeting_speaker`) or
 * learning a named speaker's voice makes a contact of a name nobody has
 * yet, as native's `ensure_label_identity` does.
 */

/** A `people` row. */
export interface MockPerson {
    id: string
    displayName: string
    email?: string
    company?: string
    role?: string
    phone?: string
    notes?: string
}

/** A voice as `voice_profiles.json` keeps it: the meetings it was learned from. */
export interface MockVoice {
    personId: string
    samples: number
    from: string[]
}

export function createMockPeople() {
    return {
        rows: [
            {
                id: 'person-priya',
                displayName: 'Priya Shah',
                role: 'Product Manager',
                company: 'Meetily',
                email: 'priya@example.com',
                notes: 'Prefers short written updates. Owns the pilot config.',
            },
            {id: 'person-marcus', displayName: 'Marcus Lee', role: 'Staff Engineer', company: 'Meetily'},
            {id: 'person-elena', displayName: 'Elena García', role: 'Design Lead', company: 'Meetily'},
            {id: 'person-tom', displayName: 'Tom Becker', role: 'IT Director', company: 'Acme Corp', email: 'tom.becker@acme.test'},
            {id: 'person-sam', displayName: 'Sam Rivera', role: 'Procurement', company: 'Acme Corp'},
        ] as MockPerson[],
        voices: [{personId: 'person-tom', samples: 6, from: ['meeting-acme-kickoff']}] as MockVoice[],
        /** Whether the speaker models a voice is learned with are downloaded. */
        speakerModels: true,
    }
}

export type MockPeople = ReturnType<typeof createMockPeople>

interface MockDb {
    people: MockPeople
    meetings: MockMeetings
    /** `voiceProfiles` is Labs › Voice profiles. */
    labs: MockLabs
}

let nextId = 0
const newPersonId = () => `person-mock-${(nextId++).toString(36)}`

const clean = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

const labelsOf = (line: TranscriptSegment) => (line.speaker ?? '').split(' + ').map((part) => part.trim()).filter(Boolean)

/** The person a label is, by native's name rule. */
const personNamed = (db: MockDb, label: string) =>
    db.people.rows.find((person) => normalizePersonName(person.displayName) === normalizePersonName(label))

/** As native's `ensure_label_identity`: a named voice nobody has as a contact becomes one. */
function ensureContact(db: MockDb, label: string): MockPerson | undefined {
    if (!isPersonLabel(label)) return undefined
    const known = personNamed(db, label)
    if (known) return known
    const person = {id: newPersonId(), displayName: label.trim()}
    db.people.rows.push(person)
    return person
}

/**
 * Native links an action item to the contact its owner names when it
 * writes the item; the meetings mock does not know people, so this runs
 * before the items are read.
 */
function linkOwners(db: MockDb) {
    for (const item of db.meetings.actionItems) {
        if (item.personId || !item.ownerLabel) continue
        const owner = personNamed(db, item.ownerLabel)
        if (owner) item.personId = owner.id
    }
}

/** The label a person carries in a meeting, if they spoke in it. */
function labelIn(db: MockDb, person: MockPerson, meetingId: string): string | undefined {
    const name = normalizePersonName(person.displayName)
    for (const line of db.meetings.transcripts[meetingId] ?? []) {
        const label = labelsOf(line).find((part) => labelsOf(line).length === 1 && normalizePersonName(part) === name)
        if (label) return label
    }
    return undefined
}

function meetingsOf(db: MockDb, person: MockPerson): PersonMeeting[] {
    return db.meetings.meetings
        .filter((meeting) => labelIn(db, person, meeting.id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((meeting) => {
            const label = labelIn(db, person, meeting.id)
            const lines = (db.meetings.transcripts[meeting.id] ?? []).filter((line) => line.speaker === label)
            const entry: PersonMeeting = {
                meetingId: meeting.id,
                title: meeting.title,
                createdAt: meeting.created_at,
                messageCount: lines.length,
                speakingSeconds: lines.reduce((sum, line) => sum + (line.duration ?? 0), 0),
            }
            if (lines[0]) entry.excerpt = lines[0].text.slice(0, 240)
            return entry
        })
}

function foldersOf(db: MockDb, meetings: PersonMeeting[]): PersonFolder[] {
    const counts = new Map<string, number>()
    for (const entry of meetings) {
        const folderId = db.meetings.meetings.find((meeting) => meeting.id === entry.meetingId)?.group_id
        if (folderId) counts.set(folderId, (counts.get(folderId) ?? 0) + 1)
    }
    return db.meetings.folders
        .filter((folder) => counts.has(folder.id))
        .map((folder) => ({id: folder.id, name: folder.name, color: folder.color, meetingCount: counts.get(folder.id)!}))
}

/** As `PersonListItem`. */
function listItem(db: MockDb, person: MockPerson): Person {
    const meetings = meetingsOf(db, person)
    const {notes: _notes, ...details} = person
    const item: Person = {...details, meetingCount: meetings.length, groups: foldersOf(db, meetings)}
    if (meetings[0]) item.lastSeenAt = meetings[0].createdAt
    return item
}

function personOf(db: MockDb, personId: unknown, missing = 'Contact not found'): MockPerson {
    const person = db.people.rows.find((entry) => entry.id === personId)
    if (!person) throw missing
    return person
}

/** Relabels a voice in one meeting; an empty name gives it a free `Speaker N`. */
const relabel = (db: MockDb, meetingId: string, from: string, to: string) => relabelSpeaker(db.meetings.transcripts[meetingId] ?? [], from, to)

/** Native refuses a blank name and one another contact has. */
function checkName(db: MockDb, name: string, self: string | null, refusal: string) {
    if (!isPersonLabel(name)) throw 'Enter a name for the contact'
    const other = personNamed(db, name)
    if (other && other.id !== self) throw refusal
}

function details(args: Record<string, unknown>): Omit<MockPerson, 'id' | 'notes'> {
    const fields: PersonDetails = {
        displayName: String(args.displayName ?? '').trim(),
        email: clean(args.email),
        company: clean(args.company),
        role: clean(args.role),
        phone: clean(args.phone),
    }
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value)) as Omit<MockPerson, 'id' | 'notes'>
}

/** As `VoiceProfileInfo`, under the contact's current name. */
function voiceInfo(db: MockDb, voice: MockVoice): VoiceProfile {
    const person = db.people.rows.find((entry) => entry.id === voice.personId)
    return {person_id: voice.personId, name: person?.displayName ?? '', samples: voice.samples, meetings: Math.max(1, voice.from.length)}
}

/** What native checks before it reads any audio for a voice. */
function checkVoices(db: MockDb) {
    if (!db.labs.voiceProfiles) throw 'Turn on Voice profiles in Settings > Labs first.'
    if (!db.people.speakerModels) throw 'Voice profiles need the speaker models. Download them in Settings > Transcription.'
}

/** Learns a voice from these meetings, replacing them or adding to the ones before. */
function storeVoice(db: MockDb, person: MockPerson, meetingIds: string[], replace: boolean): VoiceProfile {
    const earlier = db.people.voices.find((voice) => voice.personId === person.id)
    const from = replace ? meetingIds : [...new Set([...(earlier?.from ?? []), ...meetingIds])]
    const voice: MockVoice = {personId: person.id, samples: from.length * 4, from}
    db.people.voices = [...db.people.voices.filter((entry) => entry.personId !== person.id), voice]
    return voiceInfo(db, voice)
}

/**
 * The handlers of database/repositories/person.rs (but `api_global_search`)
 * and of diarization/voice_profiles.rs (its Labs switch is in ./labs.ts).
 * Two of the meetings mock's are wrapped with what native does in the same
 * write: `rename_meeting_speaker` links the new name to a contact, and
 * `api_list_action_items` answers with owners linked to theirs.
 */
export function peopleHandlers(state: MockDb): Record<string, MockHandler> {
    const meetings = meetingsHandlers(state)
    return {
        rename_meeting_speaker: async (args) => {
            const renamed = await meetings.rename_meeting_speaker(args) as { speaker: string }
            ensureContact(state, renamed.speaker)
            return renamed
        },
        api_list_action_items: (args) => {
            linkOwners(state)
            return meetings.api_list_action_items(args)
        },
        api_list_people: () => {
            linkOwners(state)
            return state.people.rows
                .map((person) => listItem(state, person))
                .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
        },
        api_get_person_profile: ({personId}) => {
            const person = personOf(state, personId, 'Person not found')
            const meetings = meetingsOf(state, person)
            const profile: PersonProfile = {
                ...listItem(state, person),
                messageCount: meetings.reduce((sum, entry) => sum + entry.messageCount, 0),
                totalSpeakingSeconds: meetings.reduce((sum, entry) => sum + entry.speakingSeconds, 0),
                meetings,
            }
            if (person.notes) profile.notes = person.notes
            if (meetings.length) profile.firstSeenAt = meetings[meetings.length - 1].createdAt
            return profile
        },
        api_update_person_notes: ({personId, notes}) => {
            const person = personOf(state, personId, 'Person not found')
            const text = clean(notes)
            if (text) person.notes = text
            else delete person.notes
            return null
        },
        api_create_person: (args) => {
            const fields = details(args)
            required(args.displayName, 'displayName', 'api_create_person')
            checkName(state, fields.displayName, null, `A contact named "${fields.displayName}" already exists`)
            const person: MockPerson = {id: newPersonId(), ...fields}
            state.people.rows.push(person)
            return listItem(state, person)
        },
        api_update_person: (args) => {
            linkOwners(state)
            const person = personOf(state, args.personId)
            const fields = details(args)
            checkName(state, fields.displayName, person.id, `Another contact is already named "${fields.displayName}". Merge them instead.`)
            if (fields.displayName !== person.displayName) {
                for (const meeting of state.meetings.meetings) {
                    const label = labelIn(state, person, meeting.id)
                    if (label) relabel(state, meeting.id, label, fields.displayName)
                }
                for (const item of state.meetings.actionItems) if (item.personId === person.id) item.ownerLabel = fields.displayName
            }
            const updated: MockPerson = {id: person.id, ...fields}
            if (person.notes) updated.notes = person.notes
            state.people.rows = state.people.rows.map((entry) => (entry.id === person.id ? updated : entry))
            return listItem(state, updated)
        },
        api_merge_people: ({sourceId, targetId}) => {
            linkOwners(state)
            if (sourceId === targetId) throw 'Choose two different contacts to merge'
            const source = personOf(state, sourceId)
            const target = personOf(state, targetId)
            for (const meeting of state.meetings.meetings) {
                const label = labelIn(state, source, meeting.id)
                if (label) relabel(state, meeting.id, label, labelIn(state, target, meeting.id) ?? target.displayName)
            }
            for (const item of state.meetings.actionItems) {
                if (item.personId === source.id) Object.assign(item, {personId: target.id, ownerLabel: target.displayName})
            }
            const notes = [target.notes, source.notes].filter(Boolean).join('\n\n')
            for (const key of ['email', 'company', 'role', 'phone'] as const) target[key] = target[key] ?? source[key]
            if (notes) target.notes = notes
            const sourceVoice = state.people.voices.find((voice) => voice.personId === source.id)
            if (sourceVoice) {
                const targetVoice = state.people.voices.find((voice) => voice.personId === target.id)
                state.people.voices = state.people.voices.filter((voice) => voice.personId !== source.id && voice.personId !== target.id)
                state.people.voices.push({
                    personId: target.id,
                    samples: sourceVoice.samples + (targetVoice?.samples ?? 0),
                    from: [...new Set([...(targetVoice?.from ?? []), ...sourceVoice.from])],
                })
            }
            state.people.rows = state.people.rows.filter((entry) => entry.id !== source.id)
            return listItem(state, target)
        },
        api_delete_person: ({personId}) => {
            linkOwners(state)
            const person = personOf(state, personId)
            for (const meeting of state.meetings.meetings) {
                const label = labelIn(state, person, meeting.id)
                if (label) relabel(state, meeting.id, label, '')
            }
            for (const item of state.meetings.actionItems) if (item.personId === person.id) delete item.personId
            state.people.rows = state.people.rows.filter((entry) => entry.id !== person.id)
            state.people.voices = state.people.voices.filter((voice) => voice.personId !== person.id)
            return null
        },

        // ---- diarization/voice_profiles.rs
        list_voice_profiles: () =>
            state.people.voices
                .filter((voice) => state.people.rows.some((person) => person.id === voice.personId))
                .map((voice) => voiceInfo(state, voice)),
        // Without a meeting, as the app always calls it: their last 10 meetings.
        enroll_person_voice: ({personId}) => {
            const person = personOf(state, personId)
            checkVoices(state)
            const from = meetingsOf(state, person).map((entry) => entry.meetingId).slice(0, 10)
            if (!from.length) throw `${person.displayName} is not named as a speaker in a saved meeting yet.`
            return storeVoice(state, person, from, true)
        },
        enroll_voice_profile: ({meetingId, speaker}) => {
            const label = String(required(speaker, 'speaker', 'enroll_voice_profile'))
            checkVoices(state)
            const generated = /^speaker /i.test(label.trim())
            if (!isPersonLabel(label)) {
                throw generated ? 'Name this speaker before learning their voice.' : 'Only a named speaker on the call can have a voice profile.'
            }
            const lines = state.meetings.transcripts[String(meetingId)] ?? []
            if (!lines.some((line) => line.speaker === label)) throw 'This named speaker is not in the saved transcript yet.'
            return storeVoice(state, ensureContact(state, label)!, [String(meetingId)], false)
        },
        delete_voice_profile: ({personId}) => {
            state.people.voices = state.people.voices.filter((voice) => voice.personId !== personId)
            return null
        },
    }
}
