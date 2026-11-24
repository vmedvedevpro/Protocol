import {CaretLeftIcon, PushPinIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css} from 'styled-components'
import {IconButton} from '@/components/ui/Button'
import type {Platform} from '@/lib/platform'
import {tween} from '@/styles/motion'
import {LinuxClose, WindowsCaptionButtons} from './WindowControls'

/**
 * The window's title strip, drawn by the app on every platform:
 *
 * - macOS keeps its traffic lights (tauri.macos.conf.json: an overlay title
 *   bar); the strip leaves room for them.
 * - Windows has no system title bar (tauri.windows.conf.json), so the strip
 *   carries the caption buttons.
 * - Linux has none either (tauri.conf.json); the strip carries GNOME's round
 *   close button and the title in the middle.
 *
 * The whole strip drags the window and double-clicks to maximize
 * (`data-tauri-drag-region="deep"`); Tauri's drag script skips buttons, so
 * they stay clickable.
 */

const Strip = styled.header<{ $platform: Platform }>`
    display: flex;
    flex: none;
    align-items: center;
    user-select: none;

    ${({$platform}) => {
        switch ($platform) {
            case 'macos':
                return css`
                    gap: ${({theme}) => theme.space[1]};
                    height: ${({theme}) => theme.sizes.titleBar.macos};
                    padding: 0 ${({theme}) => theme.space[2]} 0 ${({theme}) => theme.sizes.titleBar.trafficLights};
                `
            case 'windows':
                return css`
                    gap: ${({theme}) => theme.space[1.5]};
                    height: ${({theme}) => theme.sizes.titleBar.windows};
                    padding-left: ${({theme}) => theme.space[1.5]};
                `
            case 'linux':
                // Three columns, so the title stays centred whatever sits beside it.
                return css`
                    display: grid;
                    grid-template-columns: 1fr auto 1fr;
                    gap: ${({theme}) => theme.space[1]};
                    height: ${({theme}) => theme.sizes.titleBar.linux};
                    padding: 0 ${({theme}) => theme.space[2]};
                `
        }
    }}
`

const Side = styled.div<{ $end?: boolean }>`
    display: flex;
    align-items: center;
    justify-content: ${({$end}) => ($end ? 'flex-end' : 'flex-start')};
    gap: ${({theme}) => theme.space[1]};
    min-width: 0;
`

const Spacer = styled.span`
    flex: 1;
`

// The Windows caption: the app's name, small and muted, as the system draws it.
const Caption = styled.span<{ $alone: boolean }>`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    padding-left: ${({theme, $alone}) => ($alone ? theme.space[2] : 0)};
`

const LinuxTitle = styled.span`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    white-space: nowrap;
`

// The back button comes and goes with the screen.
const Appear = styled(m.span)`
    display: flex;
`

const appear = {
    initial: {opacity: 0},
    animate: {opacity: 1},
    exit: {opacity: 0},
    transition: tween('fast'),
}

export interface TitleBarProps {
    platform: Platform
    /** Linux shows it in the middle; the Windows caption always says Protocol. */
    title: string
    /** Shows "Back to meetings" on every screen but the meetings. */
    onBack?: () => void
    onTop: boolean
    onTopChange: (onTop: boolean) => void
}

export function TitleBar({platform, title, onBack, onTop, onTopChange}: TitleBarProps) {
    // Linux's buttons are the 32 px of its header bars; the others 28 px.
    const size = platform === 'linux' ? 'md' : 'sm'

    const back = (
        <AnimatePresence initial={false}>
            {onBack && (
                <Appear key="back" {...appear}>
                    <IconButton label="Back to meetings" size={size} onClick={onBack}>
                        <CaretLeftIcon size={15}/>
                    </IconButton>
                </Appear>
            )}
        </AnimatePresence>
    )
    const pin = (
        <IconButton label="Keep on top" size={size} pressed={onTop} onClick={() => onTopChange(!onTop)}>
            <PushPinIcon size={14}/>
        </IconButton>
    )

    return (
        <Strip $platform={platform} data-tauri-drag-region="deep">
            {platform === 'macos' && (
                <>
                    {back}
                    <Spacer/>
                    {pin}
                </>
            )}
            {platform === 'windows' && (
                <>
                    {back}
                    <Caption $alone={!onBack}>Protocol</Caption>
                    <Spacer/>
                    {pin}
                    <WindowsCaptionButtons/>
                </>
            )}
            {platform === 'linux' && (
                <>
                    <Side>{back}</Side>
                    <LinuxTitle>{title}</LinuxTitle>
                    <Side $end>
                        {pin}
                        <LinuxClose/>
                    </Side>
                </>
            )}
        </Strip>
    )
}
