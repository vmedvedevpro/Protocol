import {describe, expect, it} from 'vitest'
import {editedSpeaker, replaceSpeakerPart, storeSpeakerRename} from './speakerEdits'

describe('speaker edits', () => {
    it('replays a rename over lines past and to come, following a chain of renames', () => {
        storeSpeakerRename('meeting-1', 'Speaker 2', 'Priya')
        storeSpeakerRename('meeting-1', 'Priya', 'Priya Shah')
        expect(editedSpeaker('meeting-1', 7, 'Speaker 2')).toBe('Priya Shah')
        expect(editedSpeaker('meeting-1', 8, 'Speaker 2 + You')).toBe('Priya Shah + You')
        expect(editedSpeaker('meeting-2', 7, 'Speaker 2')).toBe('Speaker 2')
    })

    it('reads the old UI’s edits, a line moved to another voice included', () => {
        localStorage.setItem('meetily-speaker-edits:meeting-1', JSON.stringify({aliases: {'Speaker 3': 'Jo'}, turns: {4: 'Sam'}}))
        expect(editedSpeaker('meeting-1', 4, 'Speaker 3')).toBe('Sam')
        expect(editedSpeaker('meeting-1', 5, 'Speaker 3')).toBe('Jo')
    })

    it('keeps native’s label when the edits cannot be read', () => {
        localStorage.setItem('meetily-speaker-edits:meeting-1', '{"aliases":')
        expect(editedSpeaker('meeting-1', 1, 'Speaker 2')).toBe('Speaker 2')
    })

    it('stops at a name given back', () => {
        storeSpeakerRename('meeting-1', 'Speaker 2', 'Priya')
        storeSpeakerRename('meeting-1', 'Priya', 'Speaker 2')
        expect(editedSpeaker('meeting-1', 1, 'Speaker 2')).toBe('Speaker 2')
    })

    it('folds a duplicate voice when a part is renamed', () => {
        expect(replaceSpeakerPart('Speaker 2 + Priya', 'Speaker 2', 'Priya')).toBe('Priya')
    })
})
