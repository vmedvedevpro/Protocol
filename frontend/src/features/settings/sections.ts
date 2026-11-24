import type {SegmentedOption} from '@/components/ui/SegmentedControl'

/** The four sections behind the Advanced switch. */
export type SettingsSection = 'general' | 'recording' | 'ai' | 'advanced'

export const SETTINGS_SECTIONS: readonly SegmentedOption<SettingsSection>[] = [
    {value: 'general', label: 'General'},
    {value: 'recording', label: 'Recording'},
    {value: 'ai', label: 'AI'},
    {value: 'advanced', label: 'Advanced'},
]

/**
 * `?section=` takes the new ids and the old UI's, which the tray and older
 * links still send (`/settings?section=about` from Check for Updates…). Its
 * nine sections map onto four; meeting detection is gone, and its links
 * opened General already.
 */
const SECTION_IDS: Record<string, SettingsSection> = {
    general: 'general',
    about: 'general',
    detection: 'general',
    recording: 'recording',
    ai: 'ai',
    transcription: 'ai',
    summaries: 'ai',
    advanced: 'advanced',
    agents: 'advanced',
    local: 'advanced',
    labs: 'advanced',
}

/** The section a `?section=` value opens, or null for none or an unknown one. */
export function sectionFromParam(param: string | null): SettingsSection | null {
    // Own keys only: `toString` and its kind are on every object.
    return param !== null && Object.hasOwn(SECTION_IDS, param) ? SECTION_IDS[param] : null
}

/**
 * The old About held the updates; the tray opens it to check for one, so it
 * lands on General › Updates.
 */
export const opensUpdates = (param: string | null) => param === 'about'
