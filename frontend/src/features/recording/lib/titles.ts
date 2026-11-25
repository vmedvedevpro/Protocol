/**
 * A recording's automatic title (PARITY.md, Automatic meeting titles). A
 * title the user has not chosen still tells meetings apart at a glance:
 *
 *   "Meeting · Mon, Sep 28 · 2:30 PM"        while recording
 *   "Meeting · Mon, Sep 28 · 2:30–3:15 PM"   once it ends
 *   "Weekly Standup — Sep 28"                filed in a folder
 *
 * The save says whether the user chose the title (`titleManual`, #218);
 * native keeps that record and never reads the title's text for it. A
 * title the app made (these, the folder's included) gets the title the
 * summary writes; one the user typed, or a later rename, stays.
 */

export const AUTOMATIC_PREFIX = 'Meeting · '

const dayLabel = (date: Date) => date.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'})
const shortDay = (date: Date) => date.toLocaleDateString(undefined, {month: 'short', day: 'numeric'})
// Newer ICU puts a narrow no-break space before AM/PM; titles are typed and
// searched, so they keep a plain one.
const timeLabel = (date: Date) =>
    date.toLocaleTimeString(undefined, {hour: 'numeric', minute: '2-digit'}).replace(/\u202f/g, ' ')

/** "2:30–3:15 PM", or "11:30 AM–12:15 PM" when the meridiem changes. */
export function timeRange(start: Date, end: Date): string {
    const from = timeLabel(start)
    const to = timeLabel(end)
    if (from === to) return from
    const meridiem = /\s?(AM|PM)$/i
    const same = meridiem.exec(from)?.[1]
    return same && same === meridiem.exec(to)?.[1] ? `${from.replace(meridiem, '')}–${to}` : `${from}–${to}`
}

/** "Meeting · Mon, Sep 28 · 2:30 PM", or the folder's "Weekly Standup — Sep 28" (with the time if taken). */
export function automaticTitle(start: Date, folderName?: string | null, existingTitles: readonly string[] = []): string {
    const folder = folderName?.trim()
    if (!folder) return `${AUTOMATIC_PREFIX}${dayLabel(start)} · ${timeLabel(start)}`
    const base = `${folder} — ${shortDay(start)}`
    return existingTitles.includes(base) ? `${base}, ${timeLabel(start)}` : base
}

/**
 * The title to save: an untouched automatic title gets the end of its time
 * slot (after a minute or more); any other title stays as it is.
 */
export function finalTitle(title: string, start: Date, end: Date): string {
    if (title !== automaticTitle(start)) return title
    if (end.getTime() - start.getTime() < 60_000) return title
    return `${AUTOMATIC_PREFIX}${dayLabel(start)} · ${timeRange(start, end)}`
}

/** "Today, 9:30 AM", or "Mon, Sep 28, 9:30 AM" on another day: when a recording started. */
export function startedLabel(start: Date, now = new Date()): string {
    const day = start.toDateString() === now.toDateString() ? 'Today' : dayLabel(start)
    return `${day}, ${timeLabel(start)}`
}
