import {describe, expect, it} from 'vitest'
import {modelState} from './models'

describe('modelState', () => {
    it('reads both status shapes native code sends', () => {
        expect(modelState('Available')).toEqual({kind: 'ready'})
        expect(modelState('Missing')).toEqual({kind: 'missing'})
        expect(modelState({Downloading: {progress: 40}})).toEqual({kind: 'downloading', progress: 40})
        expect(modelState({Error: 'disk full'})).toEqual({kind: 'failed', error: 'disk full'})
        expect(modelState({Corrupted: {file_size: 1, expected_min_size: 2}})).toEqual({kind: 'missing'})

        expect(modelState({type: 'available'})).toEqual({kind: 'ready'})
        expect(modelState({type: 'not_downloaded'})).toEqual({kind: 'missing'})
        expect(modelState({type: 'downloading', progress: 12})).toEqual({kind: 'downloading', progress: 12})
        expect(modelState({type: 'incomplete', file_size: 1, expected_size: 2})).toEqual({kind: 'missing'})
        expect(modelState({type: 'error', message: 'bad file'})).toEqual({kind: 'failed', error: 'bad file'})
        expect(modelState(undefined)).toEqual({kind: 'missing'})
    })

    it('lets a running or failed download win over a list that has not caught up', () => {
        expect(modelState('Missing', {state: 'downloading', progress: 30})).toEqual({kind: 'downloading', progress: 30})
        expect(modelState({Downloading: {progress: 30}}, {state: 'failed', error: 'offline'})).toEqual({kind: 'failed', error: 'offline'})
    })

    it('is ready only once installed: 100 % before the completion reads 99', () => {
        expect(modelState('Missing', {state: 'downloading', progress: 100})).toEqual({kind: 'downloading', progress: 99})
        expect(modelState({Downloading: {progress: 100}})).toEqual({kind: 'downloading', progress: 99})
    })

    it('keeps an installed copy ready, except while Whisper is being enabled', () => {
        expect(modelState('Available', {state: 'failed', error: 'offline'})).toEqual({kind: 'ready'})
        expect(modelState('Available', {state: 'activating'})).toEqual({kind: 'activating'})
    })
})
