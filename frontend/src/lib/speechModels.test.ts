import {describe, expect, it} from 'vitest'
import {isCorrupted, isOfferedParakeet, speechModelChoices, withSavedModel} from './speechModels'

describe('withSavedModel', () => {
    const choices = speechModelChoices([], [{name: 'small', display_name: 'Small', status: 'Available'} as never])

    it('adds a saved model that is gone, marked as not downloaded', () => {
        expect(withSavedModel(choices, 'whisper:medium').map(({label}) => label)).toEqual(['Whisper · Small', 'Whisper · medium (not downloaded)'])
    })

    it('leaves the choices as they are when the saved one is there, or none is saved', () => {
        expect(withSavedModel(choices, 'whisper:small')).toEqual(choices)
        expect(withSavedModel(choices, null)).toEqual(choices)
    })
})

describe('the model rules', () => {
    it('offers no Parakeet v2 and knows a damaged copy', () => {
        expect(isOfferedParakeet('parakeet-tdt-0.6b-v2-int8')).toBe(false)
        expect(isCorrupted({Corrupted: {file_size: 1, expected_min_size: 2}})).toBe(true)
        expect(isCorrupted('Missing')).toBe(false)
    })
})
