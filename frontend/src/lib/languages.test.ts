import {describe, expect, it} from 'vitest'
import {meetingLanguageLabel, normaliseSummaryLanguage, summaryLanguageLabel} from './languages'

describe('normaliseSummaryLanguage', () => {
    it('keeps a code native can write a summary in', () => {
        expect(normaliseSummaryLanguage('ru')).toBe('ru')
        expect(normaliseSummaryLanguage('zh-TW')).toBe('zh-tw')
    })

    it('falls back from a regional tag to its language', () => {
        expect(normaliseSummaryLanguage('pt-BR')).toBe('pt')
        expect(normaliseSummaryLanguage('en_GB')).toBe('en')
        expect(normaliseSummaryLanguage('zh-CN')).toBe('zh')
    })

    it('gives null for anything else', () => {
        expect(normaliseSummaryLanguage('ca')).toBeNull()
        expect(normaliseSummaryLanguage('')).toBeNull()
        expect(normaliseSummaryLanguage(null)).toBeNull()
    })
})

describe('labels', () => {
    it('names a language, or shows a code it does not know', () => {
        expect(meetingLanguageLabel('auto')).toBe('Detect automatically')
        expect(meetingLanguageLabel('ru')).toBe('Russian')
        expect(meetingLanguageLabel('xx')).toBe('xx')
        expect(summaryLanguageLabel('zh-tw')).toBe('Traditional Chinese')
    })
})
