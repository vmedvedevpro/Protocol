import {describe, expect, it} from 'vitest'
import {AUTOMATIC_PREFIX, automaticTitle, finalTitle, isGeneratedTitle, startedLabel, timeRange} from './titles'

const at = (hours: number, minutes: number) => new Date(2026, 8, 28, hours, minutes)

describe('titles', () => {
    it('names a recording by its day and time, or after its folder', () => {
        expect(automaticTitle(at(14, 30))).toMatch(new RegExp(`^${AUTOMATIC_PREFIX}.+ · .*2:30`))
        expect(automaticTitle(at(14, 30), 'Weekly Standup')).toMatch(/^Weekly Standup — Sep 28$/)
        // A second one that day takes its time.
        const first = automaticTitle(at(9, 0), 'Weekly Standup')
        expect(automaticTitle(at(14, 30), 'Weekly Standup', [first])).toMatch(/^Weekly Standup — Sep 28, 2:30/)
    })

    it('tells an automatic title from one the user typed, by the whole title', () => {
        const start = at(14, 30)
        for (const title of [
            automaticTitle(start),
            finalTitle(automaticTitle(start), start, at(15, 15)),
            'Meeting · Wed, Nov 25 · 11:30 AM–12:15 PM',
            'Meeting · 25 нояб., ср · 14:30',
            'Meeting, Wed, Nov 25, 2:34 PM',
            'Meeting, Wed, Nov 25, 2:34–3:10 PM',
        ]) {
            expect(isGeneratedTitle(title), title).toBe(true)
        }
        for (const title of [
            'Meeting · budget',
            'Meeting · Wed, Nov 25 · 2:34 PM with Priya',
            'Meeting, budget review',
            'Meeting, Wed, Nov 25',
            'Pricing call',
            'Weekly Standup — Sep 28',
        ]) {
            expect(isGeneratedTitle(title), title).toBe(false)
        }
    })

    it('gives an untouched automatic title its end, and leaves any other title alone', () => {
        const start = at(14, 30)
        expect(finalTitle(automaticTitle(start), start, at(15, 15))).toMatch(/2:30–3:15/)
        expect(finalTitle(automaticTitle(start), start, new Date(start.getTime() + 30_000))).toBe(automaticTitle(start))
        expect(finalTitle('Release sync', start, at(15, 15))).toBe('Release sync')
    })

    it('writes a time range once when the meridiem stays', () => {
        expect(timeRange(at(14, 30), at(15, 15))).toMatch(/^2:30–3:15\sPM$/)
        expect(timeRange(at(11, 30), at(12, 15))).toMatch(/^11:30\sAM–12:15\sPM$/)
    })

    it('says Today for a recording of today', () => {
        const now = at(16, 0)
        expect(startedLabel(at(14, 30), now)).toMatch(/^Today, 2:30/)
        expect(startedLabel(at(14, 30), new Date(2026, 8, 29))).not.toMatch(/^Today/)
    })
})
