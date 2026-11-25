import {describe, expect, it} from 'vitest'
import {dateGroup, dayWhen, formatLength, headerWhen, rowWhen} from './dates'

// A Tuesday afternoon.
const now = new Date(2026, 10, 24, 15, 0)
const at = (month: number, day: number, hour = 9, minute = 30) => new Date(2026, month, day, hour, minute)

describe('meeting dates', () => {
    it('sorts meetings into the list\'s sections', () => {
        expect(dateGroup(at(10, 24), now)).toBe('Today')
        expect(dateGroup(at(10, 23, 23, 59), now)).toBe('Yesterday')
        expect(dateGroup(at(10, 18), now)).toBe('This week')
        expect(dateGroup(at(10, 3), now)).toBe('Earlier this month')
        expect(dateGroup(at(9, 30), now, 'en-US')).toBe('October')
        expect(dateGroup(new Date(2025, 11, 1), now, 'en-US')).toBe('December 2025')
    })

    it('words a row\'s time for its section', () => {
        expect(rowWhen(at(10, 24), now, 'en-US')).toBe('9:30 AM')
        expect(rowWhen(at(10, 23, 15, 5), now, 'en-US')).toBe('3:05 PM')
        expect(rowWhen(at(10, 21), now, 'en-US')).toBe('Sat')
        expect(rowWhen(at(10, 12), now, 'en-US')).toBe('Nov 12')
    })

    it('words a day without its time', () => {
        expect(dayWhen(at(10, 24), now, 'en-US')).toBe('Today')
        expect(dayWhen(at(10, 23, 23, 59), now, 'en-US')).toBe('Yesterday')
        expect(dayWhen(at(10, 21), now, 'en-US')).toBe('Sat')
        expect(dayWhen(at(10, 7), now, 'en-US')).toBe('Nov 7')
    })

    it('words the header\'s time', () => {
        expect(headerWhen(at(10, 24), now, 'en-US')).toBe('Today, 9:30 AM')
        expect(headerWhen(at(10, 21, 15, 5), now, 'en-US')).toBe('Saturday, 3:05 PM')
        expect(headerWhen(at(10, 12, 16, 15), now, 'en-US')).toBe('Nov 12, 4:15 PM')
    })

    it('words a meeting\'s length', () => {
        expect(formatLength(2711)).toBe('45 min')
        expect(formatLength(20)).toBe('1 min')
        expect(formatLength(4320)).toBe('1 h 12 min')
        expect(formatLength(7200)).toBe('2 h')
        expect(formatLength(undefined)).toBe('')
    })
})
