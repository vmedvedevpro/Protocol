import styled from 'styled-components'
import {SegmentedControl} from '@/components/ui/SegmentedControl'
import {THEME_MODES, useThemeModeStore} from '@/styles/themeMode'
import {changeThemeSmoothly, THEME_SWITCH_TRANSITION_NAME} from '@/styles/themeTransition'

// Out of the theme crossfade, shown only live (GlobalStyle): the thumb slides
// once instead of also standing still on the old option in the old frame.
const Frame = styled.div`
    display: flex;
    width: max-content;
    view-transition-name: ${THEME_SWITCH_TRANSITION_NAME};
`

export function ThemeSwitch() {
    const mode = useThemeModeStore((state) => state.mode)
    const setMode = useThemeModeStore((state) => state.setMode)

    return (
        <Frame>
            <SegmentedControl
                label="Theme"
                options={THEME_MODES}
                value={mode}
                onChange={(next) => changeThemeSmoothly(() => setMode(next))}
            />
        </Frame>
    )
}
