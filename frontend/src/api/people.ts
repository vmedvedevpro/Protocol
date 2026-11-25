/**
 * People: the contacts a meeting's named voices belong to
 * (database/repositories/person.rs), their Labs voice profiles
 * (diarization/voice_profiles.rs; the Labs switch itself is in labs.ts),
 * and which of a meeting's speaker labels is which contact. The person screen and search (#118) and Who said this
 * (#119) read them.
 *
 * Native links a person to a meeting through `person_speakers` (meeting,
 * label). Naming a voice links it: a name equal to a contact's, case and
 * surrounding spaces aside, joins that contact, and any other name becomes
 * a new one. Generated labels ("Speaker 2", "You", overlaps) never do.
 */
import {mutationOptions, type QueryClient, queryOptions} from '@tanstack/react-query'
import {actionItemKeys} from './actionItems'
import {command} from './core'
import {meetingKeys} from './meetings'

/** A folder (native's group) a person's meetings are filed in; mirrors `PersonGroupRef`. */
export interface PersonFolder {
    id: string
    name: string
    color?: string
    /** Their meetings in it. */
    meetingCount: number
}

/** A contact as lists show it; mirrors `PersonListItem` in person.rs. */
export interface Person {
    id: string
    displayName: string
    email?: string
    company?: string
    role?: string
    phone?: string
    /** Meetings they are named in. */
    meetingCount: number
    /** Their latest meeting's start (RFC 3339). */
    lastSeenAt?: string
    /** The folders their meetings are filed in. */
    groups: PersonFolder[]
}

/** The details the user edits; an update sends them all (`PersonInput`). */
export interface PersonDetails {
    displayName: string
    email?: string | null
    company?: string | null
    role?: string | null
    phone?: string | null
}

/** A meeting they spoke in; mirrors `PersonMeeting`. */
export interface PersonMeeting {
    meetingId: string
    title: string
    /** RFC 3339. */
    createdAt: string
    /** Their lines in it. */
    messageCount: number
    speakingSeconds: number
    /** Their first line, at most 240 characters. */
    excerpt?: string
}

/**
 * The person screen's data; mirrors `PersonProfile`. Native also sends the
 * action items they own; the screen reads them with `actionItemsQuery`,
 * which a check-off refreshes, so the copy here is left out.
 */
export interface PersonProfile {
    id: string
    displayName: string
    /** Private notes: never sent to AI. Absent when blank. */
    notes?: string
    email?: string
    company?: string
    role?: string
    phone?: string
    meetingCount: number
    messageCount: number
    totalSpeakingSeconds: number
    firstSeenAt?: string
    lastSeenAt?: string
    /** Newest first. */
    meetings: PersonMeeting[]
    groups: PersonFolder[]
}

/**
 * A learned voice; mirrors `VoiceProfileInfo` in voice_profiles.rs, which
 * serializes in snake case. Later meetings name a matching voice after the
 * contact when speakers are identified.
 */
export interface VoiceProfile {
    person_id: string
    /** The contact's current name. */
    name: string
    /** Clear turns it was learned from. */
    samples: number
    /** Meetings those turns came from. */
    meetings: number
}

export const peopleKeys = {
    all: ['people'] as const,
    lists: () => [...peopleKeys.all, 'list'] as const,
    profile: (personId: string) => [...peopleKeys.all, 'profile', personId] as const,
    voices: () => [...peopleKeys.all, 'voices'] as const,
}

// ---- Contacts ------------------------------------------------------------------

/** Every contact, most recently met first. */
export const listPeople = () => command<Person[]>('api_list_people')

/** Rejects with "Person not found" for a contact that does not exist (any longer). */
export const getPersonProfile = (personId: string) =>
    command<PersonProfile>('api_get_person_profile', {personId})

const detailArgs = (details: PersonDetails) => ({
    displayName: details.displayName,
    email: details.email ?? null,
    company: details.company ?? null,
    role: details.role ?? null,
    phone: details.phone ?? null,
})

/**
 * Adds a contact. Native trims the name and refuses a blank one or one
 * another contact has ("A contact named … already exists").
 */
export const createPerson = (details: PersonDetails) =>
    command<Person>('api_create_person', detailArgs(details))

/**
 * Replaces a contact's details. A new name relabels every meeting they spoke
 * in and their voice; a name another contact has is refused ("Merge them
 * instead").
 */
export const updatePerson = (personId: string, details: PersonDetails) =>
    command<Person>('api_update_person', {personId, ...detailArgs(details)})

/**
 * Folds `sourceId` into `targetId`: the source's meetings, action items,
 * notes and voice move to the target, which is returned, and the source is
 * deleted.
 */
export const mergePeople = (sourceId: string, targetId: string) =>
    command<Person>('api_merge_people', {sourceId, targetId})

/**
 * Deletes a contact. Their lines go back to free `Speaker N` labels, their
 * action items lose the link but keep the owner as written, and their voice
 * is forgotten; meetings stay.
 */
export const deletePerson = (personId: string) => command<null>('api_delete_person', {personId})

/** Native trims the notes and stores blank ones as none. */
export const updatePersonNotes = (personId: string, notes: string) =>
    command<null>('api_update_person_notes', {personId, notes})

// Both are read again whenever a screen mounts them (staleTime 0): deleting
// a meeting or filing it in another folder changes a contact's meeting count
// and folders, and those mutations know nothing of people.
export const peopleQuery = queryOptions({
    queryKey: peopleKeys.lists(),
    queryFn: listPeople,
    staleTime: 0,
})

export const personProfileQuery = (personId: string) =>
    queryOptions({
        queryKey: peopleKeys.profile(personId),
        queryFn: () => getPersonProfile(personId),
        staleTime: 0,
    })

/**
 * After a rename, merge or delete: native relabelled transcript lines and
 * moved or unlinked action items, so the meetings' transcripts and the items
 * are read again along with the people.
 */
function invalidateRelabelled(client: QueryClient) {
    return Promise.all([
        client.invalidateQueries({queryKey: peopleKeys.all}),
        client.invalidateQueries({queryKey: meetingKeys.all}),
        client.invalidateQueries({queryKey: actionItemKeys.all}),
    ])
}

export const createPersonMutation = mutationOptions({
    mutationFn: createPerson,
    onSuccess: (_person, _details, _result, {client}) => client.invalidateQueries({queryKey: peopleKeys.lists()}),
})

export const updatePersonMutation = (personId: string) =>
    mutationOptions({
        mutationFn: (details: PersonDetails) => updatePerson(personId, details),
        onSuccess: (_person, _details, _result, {client}) => invalidateRelabelled(client),
    })

export const mergePeopleMutation = mutationOptions({
    mutationFn: ({sourceId, targetId}: { sourceId: string, targetId: string }) => mergePeople(sourceId, targetId),
    onSuccess: (_kept, {sourceId}, _result, {client}) => {
        // The source is gone: a screen still on it must not refetch "Person not found".
        client.removeQueries({queryKey: peopleKeys.profile(sourceId)})
        return invalidateRelabelled(client)
    },
})

export const deletePersonMutation = mutationOptions({
    mutationFn: deletePerson,
    onSuccess: (_reply, personId, _result, {client}) => {
        client.removeQueries({queryKey: peopleKeys.profile(personId)})
        return invalidateRelabelled(client)
    },
})

/**
 * Saves the private notes as the user types. Saves of one contact share a
 * scope, so they land in the order they were made. The reply writes the
 * stored text into the cached profile instead of reading it again, which
 * would reset a field still being typed in.
 */
export const updatePersonNotesMutation = (personId: string) =>
    mutationOptions({
        mutationFn: (notes: string) => updatePersonNotes(personId, notes),
        scope: {id: `person-notes:${personId}`},
        onSuccess: (_reply, notes, _result, {client}) => {
            const stored = notes.trim() || undefined
            client.setQueryData(peopleKeys.profile(personId), (profile?: PersonProfile) => profile && {...profile, notes: stored})
        },
    })

// ---- A meeting's speakers ------------------------------------------------------

/** As native's `normalize_person_name`: a name matches case and outer spaces aside. */
export const normalizePersonName = (name: string) => name.trim().toLowerCase()

/**
 * Whether native would link this label to a person (`is_person_name`):
 * not blank, not the microphone or computer audio, not a generated
 * `Speaker N`, and not an overlap of several voices.
 */
export function isPersonLabel(label: string | null | undefined): label is string {
    const trimmed = label?.trim() ?? ''
    const lower = trimmed.toLowerCase()
    return !!trimmed &&
        !['you', 'guest', 'mic', 'microphone', 'system', 'system audio', 'speaker'].includes(lower) &&
        !lower.startsWith('speaker ') &&
        !trimmed.includes(' + ')
}

/**
 * The contact a meeting's speaker label belongs to. Native links labels to
 * people by this same name rule when a voice is named; no command lists a
 * meeting's links, so the label's name stands for it.
 */
export function personForSpeaker(people: readonly Person[], label: string | null | undefined): Person | undefined {
    if (!isPersonLabel(label)) return undefined
    const name = normalizePersonName(label)
    return people.find((person) => normalizePersonName(person.displayName) === name)
}

// ---- Voices (Labs) -------------------------------------------------------------

/** "14 clear turns in 3 meetings" */
export function describeVoiceSource(voice: Pick<VoiceProfile, 'samples' | 'meetings'>): string {
    const meetings = Math.max(1, voice.meetings)
    return `${voice.samples} clear turn${voice.samples === 1 ? '' : 's'} in ${meetings} meeting${meetings === 1 ? '' : 's'}`
}

/** Learned voices, each under its contact's current name. */
export const listVoiceProfiles = () => command<VoiceProfile[]>('list_voice_profiles')

/**
 * Learns a contact's voice again from their recent meetings, so it picks up
 * everything recorded since. Rejects with native's reason: Labs is off, the
 * speaker models are missing, or no meeting has clear call audio of them.
 */
export const learnPersonVoice = (personId: string) => command<VoiceProfile>('enroll_person_voice', {personId})

/** Adds one named speaker's lines in a saved meeting to their contact's voice. */
export const learnSpeakerVoice = (meetingId: string, speaker: string) =>
    command<VoiceProfile>('enroll_voice_profile', {meetingId, speaker})

export const forgetVoice = (personId: string) => command<null>('delete_voice_profile', {personId})

export const voiceProfilesQuery = queryOptions({
    queryKey: peopleKeys.voices(),
    queryFn: listVoiceProfiles,
})

// Learning a named speaker's voice can link or make their contact
// (`ensure_label_identity`), so the people are read again with the voices.
const invalidateVoices = {
    onSuccess: (_reply: unknown, _variables: unknown, _result: unknown, {client}: { client: QueryClient }) =>
        client.invalidateQueries({queryKey: peopleKeys.all}),
}

export const learnPersonVoiceMutation = mutationOptions({mutationFn: learnPersonVoice, ...invalidateVoices})

export const learnSpeakerVoiceMutation = mutationOptions({
    mutationFn: ({meetingId, speaker}: { meetingId: string, speaker: string }) => learnSpeakerVoice(meetingId, speaker),
    ...invalidateVoices,
})

export const forgetVoiceMutation = mutationOptions({mutationFn: forgetVoice, ...invalidateVoices})
