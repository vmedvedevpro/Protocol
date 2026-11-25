import {type ReactNode, use, useEffect, useRef, useState} from 'react'
import * as m from 'motion/react-m'
import {useLocation} from 'react-router-dom'
import styled from 'styled-components'
import {Veil} from '@/components/ui/Veil'
import {tween} from '@/styles/motion'
import {DownloadLine} from './DownloadLine'
import {DownloadLineContext} from './downloadLineContext'
import {RecordBarContext} from './recordBar'

// A screen arrives with a 4 px rise under a veil (Veil); the screen it
// replaces goes at once, so a click never waits for an exit.
const Main = styled(m.main)`
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;

    /* Focused only by script, after a navigation (see Screen). */
    &:focus {
        outline: none;
    }
`

const Footer = styled.footer`
    flex: none;
    border-top: 1px solid ${({theme}) => theme.colors.border};

    /* The recording bar over the screen's own bar (the meeting's player). */
    > * + * {
        border-top: 1px solid ${({theme}) => theme.colors.border};
    }

    /* Nothing docked: no footer, for the eye and for screen readers. */
    &:empty {
        display: none;
    }
`

export interface ScreenProps {
    /** The screen's own bar docked at the bottom: the meeting's player, or nothing. */
    bar?: ReactNode
    /**
     * Docks the recording bar while nothing records (the ring, the inputs and
     * Record); only Home sets it. While a recording runs or is being saved
     * the bar docks on every screen, above `bar`, whatever this says.
     */
    recordBar?: boolean
    /** The screen's content; its first heading is its `<h1>`. */
    children: ReactNode
}

/**
 * One screen of the main window: its `<main>` and the `<footer>` under it,
 * siblings of the title bar's `<header>`. Every route of the shell renders
 * one, so each screen has the banner, main and contentinfo landmarks and its
 * own h1. The footer is also where the status line of model downloads shows
 * on every screen once the shell turns it on (`DownloadLineContext`), and
 * where the recording bar docks (`recordBar`).
 *
 * A screen opened by a navigation takes focus on its `<main>`: the control
 * that navigated (Settings, Back to meetings) leaves with the old screen, and
 * focus would fall to `<body>`. The first screen of the page, before any
 * navigation (location key `default`), leaves focus where it is.
 */
export function Screen({bar, recordBar = false, children}: ScreenProps) {
    const renderRecordBar = use(RecordBarContext)
    const downloads = use(DownloadLineContext)
    const main = useRef<HTMLElement>(null)
    const {key} = useLocation()
    // Read on mount only: a screen that changes its own search params keeps focus.
    const [navigated] = useState(key !== 'default')

    useEffect(() => {
        if (navigated) main.current?.focus({preventScroll: true})
    }, [navigated])

    return (
        <>
            <Main
                ref={main}
                tabIndex={-1}
                initial={{y: 4}}
                animate={{y: 0}}
                transition={tween('base', 'enter')}
            >
                {children}
                <Veil/>
            </Main>
            <Footer>
                {downloads && <DownloadLine/>}
                {renderRecordBar?.(recordBar)}
                {bar}
            </Footer>
        </>
    )
}
