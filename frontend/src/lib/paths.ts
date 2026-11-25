/**
 * Every path the app navigates to; nothing writes one by hand. Native code
 * knows three of them, and they must keep resolving or change there too:
 * `/settings` and `/settings?section=about` (tray.rs) and `/minibar`
 * (minibar.rs, `WebviewUrl::App("minibar")`).
 */
export const paths = {
    /** The meetings list. */
    home: '/',
    /** The meetings list showing one folder (`?folder=`). */
    folder: (folderId: string) => `/?${new URLSearchParams({folder: folderId})}`,
    /**
     * A meeting, optionally on a tab and at a moment (`?at=` seconds), as a
     * search result opens a line that was said or an action item.
     */
    meeting: (meetingId: string, view: { tab?: 'notes' | 'transcript' | 'summary', at?: number, line?: string } = {}) => {
        const params = new URLSearchParams()
        if (view.tab) params.set('tab', view.tab)
        if (view.at != null && Number.isFinite(view.at)) params.set('at', String(Math.floor(view.at)))
        if (view.line) params.set('line', view.line)
        const query = params.toString()
        return `/meetings/${encodeURIComponent(meetingId)}${query ? `?${query}` : ''}`
    },
    /** A contact's screen (#118). */
    person: (personId: string) => `/person/${encodeURIComponent(personId)}`,
    recording: '/recording',
    /**
     * Settings, optionally opened at a section: the old UI's section ids
     * (`about`, `transcription`, …), which the tray still sends, map onto the
     * new sections there (#114, #117). It replaces the old sessionStorage tab keys.
     */
    settings: (section?: string) => (section ? `/settings?${new URLSearchParams({section})}` : '/settings'),
    /** A page inside Settings, such as the summary model's. */
    settingsPage: (page: 'summary-model' | 'templates' | 'chosen-apps' | 'agents' | 'speech-models') => `/settings/${page}`,
    /** The minibar window's whole UI. */
    minibar: '/minibar',
} as const
