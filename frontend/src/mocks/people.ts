import type {ActionItem} from '@/api/actionItems'
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
import {meetingsHandlers, type MockMeetings} from './meetings'

/**
 * Contacts and their voices, ported from the old browser preview
 * (`162e8be:frontend/src/dev/preview/fixtures.ts` and `index.ts`). Which
 * meetings a person spoke in is not stored here: as native's
 * `person_speakers`, it follows the transcripts, where a label with a
 * contact's name is theirs. A named voice nobody has as a contact yet
 * becomes one, as native's `ensure_label_identity` makes it when a voice
 * is named (#113's rename, #119's Who said this).
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
        /** Labs › Voice profiles (`voice_profiles_enabled.txt`). */
        voicesEnabled: false,
        /** Whether the speaker models a voice is learned with are downloaded. */
        speakerModels: true,
    }
}

export type MockPeople = ReturnType<typeof createMockPeople>

interface MockDb {
    people: MockPeople
    meetings: MockMeetings
}

let nextId = 0
const newPersonId = () => `person-mock-${(nextId++).toString(36)}`

const clean = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)

function required<T>(value: T | undefined, name: string, command: string): T {
    if (value === undefined) throw `invalid args \`${name}\` for command \`${command}\`: command ${command} missing required key ${name}`
    return value
}

const labelsOf = (line: TranscriptSegment) => (line.speaker ?? '').split(' + ').map((part) => part.trim()).filter(Boolean)

/** The person a label is, by native's name rule. */
const personNamed = (db: MockDb, label: string) =>
    db.people.rows.find((person) => normalizePersonName(person.displayName) === normalizePersonName(label))

/**
 * What native keeps true on every write: each named voice in a transcript
 * is a contact, and an action item whose owner is a contact's name is
 * linked to them. The mock applies it before every read.
 */
function sync(db: MockDb) {
    for (const lines of Object.values(db.meetings.transcripts)) {
        for (const line of lines) {
            const label = line.speaker?.trim()
            if (isPersonLabel(label) && !personNamed(db, label)) db.people.rows.push({id: newPersonId(), displayName: label})
        }
    }
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

function itemsOf(db: MockDb, personId: string): ActionItem[] {
    return db.meetings.actionItems
        .filter((item) => item.personId === personId)
        .map((item) => {
            const meeting = db.meetings.meetings.find((entry) => entry.id === item.meetingId)
            return {...item, meetingTitle: meeting?.title ?? 'Meeting', meetingCreatedAt: meeting?.created_at ?? item.createdAt}
        })
}

/** Relabels a voice in one meeting's transcript, joining it with a voice it overlapped. */
function relabel(db: MockDb, meetingId: string, from: string, to: string) {
    for (const line of db.meetings.transcripts[meetingId] ?? []) {
        const parts = labelsOf(line)
        if (parts.includes(from)) line.speaker = [...new Set(parts.map((part) => (part === from ? to : part)))].join(' + ')
    }
}

/** The lowest `Speaker N` a meeting does not use yet. */
function freeSpeaker(db: MockDb, meetingId: string): string {
    const used = new Set((db.meetings.transcripts[meetingId] ?? []).flatMap(labelsOf))
    let n = 1
    while (used.has(`Speaker ${n}`)) n += 1
    return `Speaker ${n}`
}

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

/** Learns a voice from these meetings, replacing them or adding to the ones before. */
function storeVoice(db: MockDb, person: MockPerson, meetingIds: string[], replace: boolean): VoiceProfile {
    if (!db.people.voicesEnabled) throw 'Turn on Voice profiles in Settings > Labs first.'
    if (!db.people.speakerModels) throw 'Voice profiles need the speaker models. Download them in Settings > Transcription.'
    const earlier = db.people.voices.find((voice) => voice.personId === person.id)
    const from = replace ? meetingIds : [...new Set([...(earlier?.from ?? []), ...meetingIds])]
    const voice: MockVoice = {personId: person.id, samples: from.length * 4, from}
    db.people.voices = [...db.people.voices.filter((entry) => entry.personId !== person.id), voice]
    return voiceInfo(db, voice)
}

/**
 * The handlers of database/repositories/person.rs (but `api_global_search`)
 * and diarization/voice_profiles.rs. They also link action items to their
 * owners before `api_list_action_items` answers, as native does when it
 * writes them, so that reply is the meetings mock's with `personId` set.
 */
export function peopleHandlers(state: MockDb): Record<string, MockHandler> {
    const listActionItems = meetingsHandlers(state).api_list_action_items
    return {
        api_list_action_items: (args) => {
            sync(state)
            return listActionItems(args)
        },
        api_list_people: () => {
            sync(state)
            return state.people.rows
                .map((person) => listItem(state, person))
                .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
        },
        api_get_person_profile: ({personId}) => {
            sync(state)
            const person = personOf(state, personId, 'Person not found')
            const meetings = meetingsOf(state, person)
            const profile: PersonProfile = {
                ...listItem(state, person),
                messageCount: meetings.reduce((sum, entry) => sum + entry.messageCount, 0),
                totalSpeakingSeconds: meetings.reduce((sum, entry) => sum + entry.speakingSeconds, 0),
                meetings,
                actionItems: itemsOf(state, person.id),
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
            sync(state)
            const fields = details(args)
            required(args.displayName, 'displayName', 'api_create_person')
            checkName(state, fields.displayName, null, `A contact named "${fields.displayName}" already exists`)
            const person: MockPerson = {id: newPersonId(), ...fields}
            state.people.rows.push(person)
            return listItem(state, person)
        },
        api_update_person: (args) => {
            sync(state)
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
            sync(state)
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
            sync(state)
            const person = personOf(state, personId)
            for (const meeting of state.meetings.meetings) {
                const label = labelIn(state, person, meeting.id)
                if (label) relabel(state, meeting.id, label, freeSpeaker(state, meeting.id))
            }
            for (const item of state.meetings.actionItems) if (item.personId === person.id) delete item.personId
            state.people.rows = state.people.rows.filter((entry) => entry.id !== person.id)
            state.people.voices = state.people.voices.filter((voice) => voice.personId !== person.id)
            return null
        },

        // ---- diarization/voice_profiles.rs
        get_voice_profiles_enabled: () => state.people.voicesEnabled,
        set_voice_profiles_enabled: ({value}) => {
            state.people.voicesEnabled = !!value
            return null
        },
        list_voice_profiles: () =>
            state.people.voices
                .filter((voice) => state.people.rows.some((person) => person.id === voice.personId))
                .map((voice) => voiceInfo(state, voice)),
        enroll_person_voice: ({personId, meetingId}) => {
            sync(state)
            const person = personOf(state, personId)
            const theirs = meetingsOf(state, person).map((entry) => entry.meetingId)
            const from = typeof meetingId === 'string' ? theirs.filter((id) => id === meetingId) : theirs.slice(0, 10)
            if (!from.length) throw `${person.displayName} is not named as a speaker in a saved meeting yet.`
            return storeVoice(state, person, from, meetingId == null)
        },
        enroll_voice_profile: ({meetingId, speaker}) => {
            sync(state)
            const label = String(required(speaker, 'speaker', 'enroll_voice_profile'))
            const generated = /^speaker /i.test(label.trim())
            if (!isPersonLabel(label)) {
                throw generated ? 'Name this speaker before learning their voice.' : 'Only a named speaker on the call can have a voice profile.'
            }
            const person = personNamed(state, label)
            if (!person || !labelIn(state, person, String(meetingId))) throw 'This named speaker is not in the saved transcript yet.'
            return storeVoice(state, person, [String(meetingId)], false)
        },
        delete_voice_profile: ({personId}) => {
            state.people.voices = state.people.voices.filter((voice) => voice.personId !== personId)
            return null
        },
    }
}
