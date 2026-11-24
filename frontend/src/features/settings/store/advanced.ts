import {create} from 'zustand'
import {persist} from 'zustand/middleware'

/** New in Frontend 2.0, so Zustand's own format under a new key. */
export const SETTINGS_ADVANCED_KEY = 'protocol-settings-advanced'

interface AdvancedSettingsState {
    /**
     * Every section is shown, not only the simple page. Turning it off only
     * hides them: both views change the same settings.
     */
    advanced: boolean
    setAdvanced: (advanced: boolean) => void
}

export const useAdvancedSettingsStore = create<AdvancedSettingsState>()(
    persist(
        (set) => ({
            advanced: false,
            setAdvanced: (advanced) => set({advanced}),
        }),
        {name: SETTINGS_ADVANCED_KEY, partialize: ({advanced}) => ({advanced})},
    ),
)
