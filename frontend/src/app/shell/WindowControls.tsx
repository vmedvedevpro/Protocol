import {type ReactNode, useEffect, useState} from 'react'
import styled from 'styled-components'
import {closeWindow, isWindowMaximized, minimizeWindow, onWindowResized, toggleMaximizeWindow} from '@/api/window'
import {focusRing} from '@/components/ui/styles'
import {Tooltip} from '@/components/ui/Tooltip'

// The buttons the system would draw, where the app draws the title bar
// itself. Closing the main window hides it to the tray (lib.rs);
// minimizing it during a recording opens the minibar.

const report = (action: string) => (error: unknown) => console.warn(`Failed to ${action} the window:`, error)

/** Follows maximize and restore, whichever way they happen (a double-click, Win+Up). */
function useMaximized(): boolean {
    const [maximized, setMaximized] = useState(false)

    useEffect(() => {
        let current = true
        const sync = () => {
            isWindowMaximized().then((value) => current && setMaximized(value), report('read'))
        }
        sync()
        const stop = onWindowResized(sync)
        return () => {
            current = false
            stop()
        }
    }, [])

    return maximized
}

const Group = styled.div`
    display: flex;
    align-self: stretch;
`

// Windows 11's caption buttons: 46 px wide, the strip's height, a grey
// field under the pointer, and the system red under it on Close.
const CaptionButton = styled.button<{ $close?: boolean }>`
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.titleBar.caption};
    padding: 0;
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    cursor: default;
    transition-property: color, background-color;
    transition-duration: ${({theme}) => theme.motion.duration.fast};
    transition-timing-function: ${({theme}) => theme.motion.easing.standard};
    ${focusRing};

    &:focus-visible {
        outline-offset: -2px;
    }

    &:hover,
    &:active {
        background: ${({theme, $close}) => ($close ? theme.colors.captionClose : theme.colors.surface)};
        color: ${({theme, $close}) => ($close ? theme.colors.captionCloseText : theme.colors.text)};
    }
`

// The glyphs are Windows 11's 10 px line icons, not Phosphor's: these are the
// system's own buttons, drawn by the app.
const Glyph = ({children}: { children: ReactNode }) => (
    <svg aria-hidden width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
        {children}
    </svg>
)

export function WindowsCaptionButtons() {
    const maximized = useMaximized()
    const resize = maximized ? 'Restore' : 'Maximize'

    return (
        <Group role="group" aria-label="Window">
            <Tooltip content="Minimize">
                <CaptionButton type="button" aria-label="Minimize" onClick={() => minimizeWindow().catch(report('minimize'))}>
                    <Glyph><path d="M0 5h10"/></Glyph>
                </CaptionButton>
            </Tooltip>
            <Tooltip content={resize}>
                <CaptionButton type="button" aria-label={resize} onClick={() => toggleMaximizeWindow().catch(report('resize'))}>
                    {maximized ? (
                        <Glyph>
                            <path d="M2.5 2.5v-.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8 7.5h-.5"/>
                            <rect x="0.5" y="2.5" width="7" height="7" rx="1.5"/>
                        </Glyph>
                    ) : (
                        <Glyph><rect x="0.5" y="0.5" width="9" height="9" rx="1.5"/></Glyph>
                    )}
                </CaptionButton>
            </Tooltip>
            <Tooltip content="Close">
                <CaptionButton type="button" aria-label="Close" $close onClick={() => closeWindow().catch(report('close'))}>
                    <Glyph><path d="M0 0l10 10M10 0 0 10"/></Glyph>
                </CaptionButton>
            </Tooltip>
        </Group>
    )
}

// GNOME's close: a small grey disc inside a 32 px target.
const RoundButton = styled.button`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.control.md};
    height: ${({theme}) => theme.sizes.control.md};
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.pill};
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    cursor: default;
    ${focusRing};

    & > span {
        display: flex;
        align-items: center;
        justify-content: center;
        width: ${({theme}) => theme.sizes.titleBar.closeDisc};
        height: ${({theme}) => theme.sizes.titleBar.closeDisc};
        border-radius: ${({theme}) => theme.radii.pill};
        background: ${({theme}) => theme.colors.surface};
        transition: background-color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    &:hover > span,
    &:active > span {
        background: ${({theme}) => theme.colors.track};
    }
`

export function LinuxClose() {
    return (
        <Tooltip content="Close">
            <RoundButton type="button" aria-label="Close" onClick={() => closeWindow().catch(report('close'))}>
                <span>
                    <svg aria-hidden width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M1 1l8 8M9 1 1 9"/>
                    </svg>
                </span>
            </RoundButton>
        </Tooltip>
    )
}
