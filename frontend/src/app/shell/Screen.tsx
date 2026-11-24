import type {ReactNode} from 'react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {tween} from '@/styles/motion'

// A screen arrives with a fade and a 4 px rise; the screen it replaces goes
// at once, so a click never waits for an exit.
const Main = styled(m.main)`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
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
 */
export function Screen({bar, children}: ScreenProps) {
    return (
        <>
            <Main initial={{opacity: 0, y: 4}} animate={{opacity: 1, y: 0}} transition={tween('base', 'enter')}>
                {children}
            </Main>
            <Footer>{bar}</Footer>
        </>
    )
}
