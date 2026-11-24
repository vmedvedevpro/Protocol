import {type ReactNode, useEffect, useRef, useState} from 'react'
import * as m from 'motion/react-m'
import {useLocation} from 'react-router-dom'
import styled from 'styled-components'
import {tween} from '@/styles/motion'

// A screen arrives with a fade and a 4 px rise; the screen it replaces goes
// at once, so a click never waits for an exit.
const Main = styled(m.main)`
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

    /* Nothing docked: no footer, for the eye and for screen readers. */
    &:empty {
        display: none;
    }
`

export interface ScreenProps {
    /**
     * What docks at the bottom of the window on this screen: the recording
     * bar (`DockedBar`), the meeting's player, or nothing.
     */
    bar?: ReactNode
    /** The screen's content; its first heading is its `<h1>`. */
    children: ReactNode
}

/**
 * One screen of the main window: its `<main>` and the `<footer>` under it,
 * siblings of the title bar's `<header>`. Every route of the shell renders
 * one, so each screen has the banner, main and contentinfo landmarks and its
 * own h1. The footer is also where the download status line goes on every
 * screen (#117).
 *
 * A screen opened by a navigation takes focus on its `<main>`: the control
 * that navigated (Settings, Back to meetings) leaves with the old screen, and
 * focus would fall to `<body>`. The first screen of the page, before any
 * navigation (location key `default`), leaves focus where it is.
 */
export function Screen({bar, children}: ScreenProps) {
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
                initial={{opacity: 0, y: 4}}
                animate={{opacity: 1, y: 0}}
                transition={tween('base', 'enter')}
            >
                {children}
            </Main>
            <Footer>{bar}</Footer>
        </>
    )
}
