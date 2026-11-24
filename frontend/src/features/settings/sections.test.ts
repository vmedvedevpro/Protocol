import {describe, expect, it} from 'vitest'
import {opensUpdates, sectionFromParam} from './sections'

describe('sectionFromParam', () => {
    it('maps the old UI’s nine sections onto four', () => {
        const old = ['general', 'about', 'detection', 'recording', 'transcription', 'summaries', 'agents', 'local', 'labs']
        expect(old.map(sectionFromParam)).toEqual([
            'general', 'general', 'general', 'recording', 'ai', 'ai', 'advanced', 'advanced', 'advanced',
        ])
    })

    it('ignores nothing and unknown ids', () => {
        expect(sectionFromParam(null)).toBeNull()
        expect(sectionFromParam('toString')).toBeNull()
        expect(opensUpdates('about')).toBe(true)
        expect(opensUpdates('general')).toBe(false)
    })
})
