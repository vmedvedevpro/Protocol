/**
 * Dates as the meetings list, a meeting's header, search and a contact's
 * meetings word them, in the user's locale. `now` and `locale` are parameters so tests pin them.
 */

const DAY_MS = 86_400_000

/** Calendar days from `date` to `now`: 0 today, 1 yesterday. */
function daysAgo(date: Date, now: Date): number {
    const start = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
    return Math.round((start(now) - start(date)) / DAY_MS)
}

/** `2026-11-26`, the local date. */
export const isoDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function parseDate(value?: string | null): Date | null {
    if (!value) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

/** The list's section for a meeting: Today, Yesterday, This week, Earlier this month, then a month. */
export function dateGroup(date: Date, now = new Date(), locale?: string): string {
    const days = daysAgo(date, now)
    if (days <= 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return 'This week'
    if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) return 'Earlier this month'
    return date.toLocaleDateString(locale, {
        month: 'long',
        year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    })
}

export const formatTime = (date: Date, locale?: string) =>
    date.toLocaleTimeString(locale, {hour: 'numeric', minute: '2-digit'})

function shortDate(date: Date, now: Date, locale?: string) {
    return date.toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
    })
}

/** A row's time, beside its section: "9:30 AM" today and yesterday, "Sat" this week, "Nov 12" before. */
export function rowWhen(date: Date, now = new Date(), locale?: string): string {
    const days = daysAgo(date, now)
    if (days <= 1) return formatTime(date, locale)
    if (days < 7) return date.toLocaleDateString(locale, {weekday: 'short'})
    return shortDate(date, now, locale)
}

/** A day without its time, as a contact's meetings list them: "Today", "Yesterday", "Sat", "Nov 7". */
export function dayWhen(date: Date, now = new Date(), locale?: string): string {
    const days = daysAgo(date, now)
    if (days <= 0) return 'Today'
    if (days === 1) return 'Yesterday'
    if (days < 7) return date.toLocaleDateString(locale, {weekday: 'short'})
    return shortDate(date, now, locale)
}

/** A meeting's header: "Today, 9:30 AM", "Saturday, 3:05 PM", "Nov 12, 4:15 PM". */
export function headerWhen(date: Date, now = new Date(), locale?: string): string {
    const days = daysAgo(date, now)
    const time = formatTime(date, locale)
    if (days <= 0) return `Today, ${time}`
    if (days === 1) return `Yesterday, ${time}`
    if (days < 7) return `${date.toLocaleDateString(locale, {weekday: 'long'})}, ${time}`
    return `${shortDate(date, now, locale)}, ${time}`
}

/** "45 min", "1 h 12 min"; under a minute counts as one. Empty without a length. */
export function formatLength(seconds?: number | null): string {
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return ''
    const minutes = Math.max(1, Math.round(seconds / 60))
    if (minutes < 60) return `${minutes} min`
    const rest = minutes % 60
    return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${minutes / 60} h`
}
