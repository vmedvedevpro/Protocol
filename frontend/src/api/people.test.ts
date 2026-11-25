import type {MutationOptions, QueryClient} from '@tanstack/react-query'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {actionItemKeys, actionItemsQuery, createActionItem} from './actionItems'
import {getAllTranscripts, meetingKeys, meetingTranscriptsQuery, renameMeetingSpeaker} from './meetings'
import {
    createPersonMutation,
    deletePersonMutation,
    describeVoiceSource,
    forgetVoiceMutation,
    isPersonLabel,
    learnPersonVoiceMutation,
    learnSpeakerVoice,
    meetingSpeakerPeople,
    mergePeopleMutation,
    peopleKeys,
    peopleQuery,
    type Person,
    personForSpeaker,
    personProfileQuery,
    setVoiceProfilesEnabledMutation,
    updatePersonMutation,
    updatePersonNotesMutation,
    voiceProfilesEnabledQuery,
    voiceProfilesQuery,
} from './people'

/** Runs a mutation's options as useMutation would, without React. */
function run<TData, TVariables>(client: QueryClient, options: MutationOptions<TData, Error, TVariables>, variables: NoInfer<TVariables>) {
    return client.getMutationCache().build(client, options).execute(variables)
}

const speakers = async (meetingId: string) => new Set((await getAllTranscripts(meetingId)).map((line) => line.speaker))

describe('people', () => {
    it('lists contacts most recently met first, with their meetings and folders', async () => {
        const people = await createTestQueryClient().fetchQuery(peopleQuery)

        const priya = people.find((person) => person.id === 'person-priya')!
        expect(priya).toMatchObject({displayName: 'Priya Shah', company: 'Meetily', email: 'priya@example.com'})
        expect(priya.meetingCount).toBe(7)
        expect(priya.groups.map((folder) => folder.name).sort()).toEqual(['Acme Corp', 'Design Team', 'Weekly Standup'])
        expect(priya).not.toHaveProperty('notes')
        expect(people.map((person) => person.lastSeenAt ?? '')).toEqual(people.map((person) => person.lastSeenAt ?? '').sort().reverse())
    })

    it('makes a newly named voice a contact, as native does', async () => {
        await renameMeetingSpeaker('meeting-untitled', 'Speaker 1', 'Dana Wu')

        const people = await createTestQueryClient().fetchQuery(peopleQuery)

        expect(people.find((person) => person.displayName === 'Dana Wu')).toMatchObject({meetingCount: 1})
        expect(people.some((person) => person.displayName === 'Speaker 2')).toBe(false)
    })

    it('reads a profile: meetings together, speaking time and the items they own', async () => {
        await createActionItem('meeting-acme-review', {text: 'Send the support terms', ownerLabel: 'priya shah'})
        const client = createTestQueryClient()

        const profile = await client.fetchQuery(personProfileQuery('person-priya'))

        expect(profile.notes).toBe('Prefers short written updates. Owns the pilot config.')
        expect(profile.meetings[0]).toMatchObject({meetingId: 'meeting-acme-review', messageCount: 3})
        expect(profile.meetings[0].excerpt).toMatch(/^Yes\. We can ship a config/)
        expect(profile.totalSpeakingSeconds).toBeGreaterThan(0)
        expect(profile.firstSeenAt! < profile.lastSeenAt!).toBe(true)
        expect(profile.actionItems.map((item) => item.text)).toEqual(['Send the support terms'])
        // The owner as written matched them, so the items list filters by them too.
        expect((await client.fetchQuery(actionItemsQuery({personId: 'person-priya'}))).map((item) => item.text)).toEqual(['Send the support terms'])
        await expect(client.fetchQuery(personProfileQuery('person-gone'))).rejects.toThrow('Person not found')
    })

    it('adds a contact and refuses a name another has', async () => {
        const client = createTestQueryClient()

        const added = await run(client, createPersonMutation, {displayName: '  Jordan Kim ', company: 'Acme Corp', email: ''})

        expect(added).toMatchObject({displayName: 'Jordan Kim', company: 'Acme Corp', meetingCount: 0, groups: []})
        expect(added).not.toHaveProperty('email')
        await expect(run(client, createPersonMutation, {displayName: 'tom becker'})).rejects.toThrow('A contact named "tom becker" already exists')
        await expect(run(client, createPersonMutation, {displayName: 'Speaker 3'})).rejects.toThrow('Enter a name for the contact')
    })

    it('renames a contact in every meeting and reads the transcripts again', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(meetingTranscriptsQuery('meeting-acme-review'))

        await run(client, updatePersonMutation('person-tom'), {displayName: 'Thomas Becker', role: 'CISO', company: 'Acme Corp'})

        expect(await speakers('meeting-acme-kickoff')).toContain('Thomas Becker')
        expect(client.getQueryState(meetingKeys.transcripts('meeting-acme-review'))?.isInvalidated).toBe(true)
        const tom = (await client.fetchQuery(peopleQuery)).find((person) => person.id === 'person-tom')!
        expect(tom).toMatchObject({displayName: 'Thomas Becker', role: 'CISO', meetingCount: 2})
        expect(tom).not.toHaveProperty('email')
        await expect(run(client, updatePersonMutation('person-tom'), {displayName: 'Priya Shah'})).rejects.toThrow('Merge them instead')
    })

    it('merges one contact into another and drops the one that went', async () => {
        await createActionItem('meeting-acme-review', {text: 'Draft the procurement memo', ownerLabel: 'Sam Rivera'})
        const client = createTestQueryClient()
        await client.fetchQuery(personProfileQuery('person-sam'))
        await client.fetchQuery(actionItemsQuery({personId: 'person-sam'}))

        const kept = await run(client, mergePeopleMutation, {sourceId: 'person-sam', targetId: 'person-tom'})

        expect(kept.id).toBe('person-tom')
        expect(await speakers('meeting-acme-review')).not.toContain('Sam Rivera')
        expect(client.getQueryData(peopleKeys.profile('person-sam'))).toBeUndefined()
        expect(client.getQueryState(actionItemKeys.list({personId: 'person-sam'}))?.isInvalidated).toBe(true)
        const profile = await client.fetchQuery(personProfileQuery('person-tom'))
        expect(profile.actionItems.map((item) => [item.text, item.ownerLabel])).toEqual([['Draft the procurement memo', 'Tom Becker']])
    })

    it('deletes a contact: their lines get a free Speaker label and their items lose the link', async () => {
        await createActionItem('meeting-acme-review', {text: 'Write the retention statement', ownerLabel: 'Sam Rivera'})
        const client = createTestQueryClient()

        await run(client, deletePersonMutation, 'person-sam')

        expect(await speakers('meeting-acme-review')).toContain('Speaker 1')
        expect((await client.fetchQuery(peopleQuery)).some((person) => person.id === 'person-sam')).toBe(false)
        const [item] = await client.fetchQuery(actionItemsQuery({meetingId: 'meeting-acme-review'}))
        expect(item).toMatchObject({ownerLabel: 'Sam Rivera'})
        expect(item).not.toHaveProperty('personId')
    })

    it('saves notes into the cached profile without reading it again', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(personProfileQuery('person-marcus'))

        await run(client, updatePersonNotesMutation('person-marcus'), '  Owns the player work.  ')

        expect(client.getQueryData(peopleKeys.profile('person-marcus'))).toMatchObject({notes: 'Owns the player work.'})
        expect(client.getQueryState(peopleKeys.profile('person-marcus'))?.isInvalidated).toBe(false)
        expect(mockState.people.rows.find((person) => person.id === 'person-marcus')?.notes).toBe('Owns the player work.')

        await run(client, updatePersonNotesMutation('person-marcus'), '   ')
        expect(client.getQueryData(peopleKeys.profile('person-marcus'))).not.toHaveProperty('notes', expect.anything())
    })

    it('maps a meeting’s speaker labels to contacts by name, never generated ones', async () => {
        const people = await createTestQueryClient().fetchQuery(peopleQuery)

        expect(personForSpeaker(people, '  priya SHAH ')?.id).toBe('person-priya')
        for (const label of ['You', 'Speaker 2', 'Speaker 2 + Priya Shah', '', null, 'Guest']) {
            expect(personForSpeaker(people, label)).toBeUndefined()
        }
        const mapped = meetingSpeakerPeople(people, ['You', 'Tom Becker', 'Sam Rivera', 'Speaker 4', 'Nobody Known'])
        expect([...mapped].map(([label, person]: [string, Person]) => [label, person.id])).toEqual([
            ['Tom Becker', 'person-tom'],
            ['Sam Rivera', 'person-sam'],
        ])
        expect(isPersonLabel('Elena García')).toBe(true)
        expect(isPersonLabel('system audio')).toBe(false)
    })

    it('learns, lists and forgets a voice once Labs allows it', async () => {
        const client = createTestQueryClient()
        expect(await client.fetchQuery(voiceProfilesEnabledQuery)).toBe(false)
        await expect(run(client, learnPersonVoiceMutation, {personId: 'person-priya'})).rejects.toThrow('Turn on Voice profiles')

        await run(client, setVoiceProfilesEnabledMutation, true)
        expect(client.getQueryState(voiceProfilesEnabledQuery.queryKey)?.isInvalidated).toBe(true)
        await client.fetchQuery(voiceProfilesQuery)
        const voice = await run(client, learnPersonVoiceMutation, {personId: 'person-priya'})

        expect(voice).toMatchObject({person_id: 'person-priya', name: 'Priya Shah', meetings: 7})
        expect(describeVoiceSource(voice)).toBe('28 clear turns in 7 meetings')
        expect(client.getQueryState(voiceProfilesQuery.queryKey)?.isInvalidated).toBe(true)
        await expect(learnSpeakerVoice('meeting-acme-review', 'Speaker 2')).rejects.toThrow('Name this speaker before learning their voice.')
        expect(await learnSpeakerVoice('meeting-acme-review', 'Tom Becker')).toMatchObject({person_id: 'person-tom', meetings: 2})

        await run(client, forgetVoiceMutation, 'person-tom')
        expect((await client.fetchQuery(voiceProfilesQuery)).map((entry) => entry.person_id)).toEqual(['person-priya'])
        expect(describeVoiceSource({samples: 1, meetings: 0})).toBe('1 clear turn in 1 meeting')
    })
})
