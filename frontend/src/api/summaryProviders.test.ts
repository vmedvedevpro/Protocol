import {describe, expect, it} from 'vitest'
import {CommandError} from './core'
import {isRetryableModelListError, keyFingerprint, ModelListError, type ModelListFailure, modelListFailureText} from './summaryProviders'

describe('cloud model listing failures', () => {
    it('words each cause', () => {
        expect(modelListFailureText('claude', {kind: 'keyRejected', status: 403})).toMatch(/^Claude didn’t accept this key \(status 403\)/)
        expect(modelListFailureText('openai', {kind: 'unreachable', reason: 'no answer within 10 s'})).toBe('Couldn’t reach OpenAI: no answer within 10 s.')
        expect(modelListFailureText('groq', {kind: 'status', status: 500, reason: 'Internal Server Error'})).toBe('Groq answered with status 500 Internal Server Error.')
        expect(modelListFailureText('claude', {kind: 'invalidKey'})).toMatch(/characters a key can’t have/)
    })

    it('offers to try again only when the same key may work', () => {
        const retryable: ModelListFailure[] = [{kind: 'unreachable', reason: 'no connection'}, {kind: 'status', status: 529, reason: null}, {kind: 'invalidResponse', reason: 'x'}]
        const fixedInTheField: ModelListFailure[] = [{kind: 'missingKey'}, {kind: 'invalidKey'}, {kind: 'keyRejected', status: 401}, {kind: 'clientUnavailable', reason: 'x'}]
        for (const failure of retryable) expect(isRetryableModelListError(new ModelListError('claude', failure))).toBe(true)
        for (const failure of fixedInTheField) expect(isRetryableModelListError(new ModelListError('claude', failure))).toBe(false)
        // OpenRouter rejects with plain text; asking its public catalog again may work.
        expect(isRetryableModelListError(new CommandError('get_openrouter_models', 'HTTP request failed'))).toBe(true)
    })

    it('keys each key’s list apart without holding the key', () => {
        expect(keyFingerprint('sk-ant-a')).not.toBe(keyFingerprint('sk-ant-b'))
        expect(keyFingerprint('sk-ant-a')).toBe(keyFingerprint('sk-ant-a'))
        expect(keyFingerprint('sk-ant-secret')).not.toContain('secret')
    })
})
