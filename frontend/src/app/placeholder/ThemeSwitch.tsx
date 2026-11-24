import styled from 'styled-components'
import {THEME_MODES, useThemeModeStore} from '@/styles/themeMode'

const Track = styled.div`
    display: inline-flex;
    width: max-content;
    height: ${({theme}) => theme.sizes.control.sm};
    gap: ${({theme}) => theme.space[0.5]};
    padding: ${({theme}) => theme.space[0.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.bg};
`

// A native radio under each segment: arrow keys and focus come from the
// browser, and the shared `name` makes them one group.
const Segment = styled.label<{ $selected: boolean }>`
    position: relative;
    display: inline-flex;
    align-items: center;
    padding: 0 ${({theme}) => theme.space[2]};
    border-radius: ${({theme}) => theme.radii.xs};
    ${({theme}) => theme.text.small};
    color: ${({theme, $selected}) => ($selected ? theme.colors.text : theme.colors.muted)};
    background: ${({theme, $selected}) => ($selected ? theme.colors.raised : 'transparent')};
    box-shadow: ${({theme, $selected}) => ($selected ? theme.shadows.raised : 'none')};
    white-space: nowrap;
    cursor: pointer;

    &:has(input:focus-visible) {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: 1px;
    }

    input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
    }
`

export function ThemeSwitch() {
    const mode = useThemeModeStore((state) => state.mode)
    const setMode = useThemeModeStore((state) => state.setMode)

    return (
        <Track role="radiogroup" aria-label="Theme">
            {THEME_MODES.map((option) => (
                <Segment key={option.mode} $selected={option.mode === mode}>
                    <input
                        type="radio"
                        name="theme"
                        value={option.mode}
                        checked={option.mode === mode}
                        onChange={() => setMode(option.mode)}
                    />
                    {option.label}
                </Segment>
            ))}
        </Track>
    )
}
