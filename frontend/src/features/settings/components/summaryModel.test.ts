import {describe, expect, it} from 'vitest'
import type {SummaryModelConfig} from '@/api/preferences'
import {describeSummaryModel} from './summaryModel'

const config = (patch: Partial<SummaryModelConfig>): SummaryModelConfig => ({
    provider: 'builtin-ai',
    model: 'qwen3.5:4b',
    whisperModel: '',
    apiKey: null,
    ollamaEndpoint: null,
    summaryMaxTokens: null,
    ...patch,
} as SummaryModelConfig)

describe('describeSummaryModel', () => {
    it('names the built-in model without its tag', () => {
        expect(describeSummaryModel(config({}), 'Qwen 3.5 4B (High Quality)')).toEqual({value: 'Built-in · Qwen 3.5 4B'})
        expect(describeSummaryModel(config({}))).toEqual({value: 'Built-in · qwen3.5:4b'})
    })

    it('says a cloud provider still needs its key', () => {
        expect(describeSummaryModel(config({provider: 'claude', model: 'claude-sonnet'})))
            .toEqual({value: 'Claude · claude-sonnet', description: 'Needs an API key'})
        expect(describeSummaryModel(config({provider: 'ollama', model: 'gemma3:1b'}))).toEqual({value: 'Ollama · gemma3:1b'})
    })

    it('asks for a choice when there is none', () => {
        expect(describeSummaryModel(null)).toEqual({value: 'Not chosen'})
        expect(describeSummaryModel(config({provider: ''})).value).toBe('Not chosen')
    })
})
