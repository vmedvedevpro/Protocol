/**
 * Every path the app navigates to; nothing writes one by hand. Native code
 * knows three of them, and they must keep resolving or change there too:
 * `/settings` and `/settings?section=about` (tray.rs) and `/minibar`
 * (minibar.rs, `WebviewUrl::App("minibar")`).
 */
export const paths = {
    /** The meetings list. */
    home: '/',
    meeting: (meetingId: string) => `/meetings/${encodeURIComponent(meetingId)}`,
    recording: '/recording',
    /**
     * Settings, optionally opened at a section: the old UI's section ids
     * (`about`, `transcription`, …), which the tray still sends, map onto the
     * new sections there (#114, #117). It replaces the old sessionStorage tab keys.
     */
    settings: (section?: string) => (section ? `/settings?${new URLSearchParams({section})}` : '/settings'),
    /** The minibar window's whole UI. */
    minibar: '/minibar',
} as const
