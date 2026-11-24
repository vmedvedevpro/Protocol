import {SegmentedControl} from '@/components/ui/SegmentedControl'
import {THEME_MODES, useThemeModeStore} from '@/styles/themeMode'
import {changeThemeSmoothly} from '@/styles/themeTransition'

export function ThemeSwitch() {
    const mode = useThemeModeStore((state) => state.mode)
    const setMode = useThemeModeStore((state) => state.setMode)

    return (
        <SegmentedControl
            label="Theme"
            options={THEME_MODES}
            value={mode}
            onChange={(next) => changeThemeSmoothly(() => setMode(next))}
        />
    )
}
