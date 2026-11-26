import {describe, expect, it} from 'vitest'
import {AUTOMATIC_PREFIX, automaticTitle, finalTitle, isGeneratedTitle, startedLabel, timeRange} from './titles'

const at = (hours: number, minutes: number) => new Date(2026, 8, 28, hours, minutes)

describe('titles', () => {
    it('names a recording by its day and time, or after its folder', () => {
        expect(automaticTitle(at(14, 30))).toMatch(new RegExp(`^${AUTOMATIC_PREFIX}.+, .*2:30`))
        expect(automaticTitle(at(14, 30))).not.toContain('\u00B7')
        expect(automaticTitle(at(14, 30), 'Weekly Standup')).toMatch(/^Weekly Standup — Sep 28$/)
        // A second one that day takes its time.
        const first = automaticTitle(at(9, 0), 'Weekly Standup')
        expect(automaticTitle(at(14, 30), 'Weekly Standup', [first])).toMatch(/^Weekly Standup — Sep 28, 2:30/)
    })

    it('tells an automatic title from one the user typed, by the whole title and its day', () => {
        const start = at(14, 30)
        // The day the app writes for this start, in the test's locale ("Mon, Sep 28").
        const day = start.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})
        const otherDay = new Date(2026, 8, 29, 14, 30).toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})
        // Titles stored before #219 joined the parts with a middle dot.
        const dot = ' \u00B7 '
        for (const title of [
            automaticTitle(start),
            finalTitle(automaticTitle(start), start, at(15, 15)),
            `Meeting, ${day}, 2:30 PM`,
            `Meeting, ${day}, 2:30–3:10 PM`,
            `Meeting${dot}${day}${dot}2:30 PM`,
            `Meeting${dot}${day}${dot}11:30 AM–12:15 PM`,
        ]) {
            expect(isGeneratedTitle(title, start), title).toBe(true)
        }
        for (const title of [
            `Meeting${dot}budget`,
            `Meeting${dot}${day}${dot}2:30 PM with Priya`,
            `Meeting${dot}budget review${dot}10:30`,
            `Re: Meeting${dot}${day}${dot}2:30 PM`,
            'Meeting, budget review, 10:30',
            'Meeting, budget review',
            `Meeting, ${day}`,
            `Meeting, ${day}, 2:30 PM with Priya`,
            `Notes: Meeting, ${day}, 2:30 PM`,
            // The two forms are not mixed.
            `Meeting, ${day}${dot}2:30 PM`,
            `Meeting${dot}${day}, 2:30 PM`,
            'Meeting v2.10',
            'Pricing call',
            'Weekly Standup — Sep 28',
            // Another day's automatic title, in either form, is not this recording's.
            automaticTitle(new Date(2026, 8, 29, 14, 30)),
            `Meeting${dot}${otherDay}${dot}2:30 PM`,
        ]) {
            expect(isGeneratedTitle(title, start), title).toBe(false)
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
