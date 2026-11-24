import type {ReactNode} from 'react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {type Status, StatusLine} from '@/components/ui/StatusLine'
import {tween} from '@/styles/motion'

/**
 * The window's status line, in the bottom bar on every screen: one line
 * while any model downloads, which opens Settings › Speech models (#117
 * fills it). `null` hides it.
 */
function useFooterStatus(): Status | null {
    return null
}

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

    /* No bar and no status: no footer, for the eye and for screen readers. */
    &:empty {
        display: none;
    }
`

const StatusRow = styled(m.div)`
    display: flex;
    align-items: center;
    min-width: 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[4]} 0;
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
 * own h1, and the status line shows whatever the screen.
 */
export function Screen({bar, children}: ScreenProps) {
    const status = useFooterStatus()

    return (
        <>
            <Main initial={{opacity: 0, y: 4}} animate={{opacity: 1, y: 0}} transition={tween('base', 'enter')}>
                {children}
            </Main>
            <Footer>
                <AnimatePresence initial={false}>
                    {status && (
                        <StatusRow
                            key="status"
                            initial={{opacity: 0, y: 4}}
                            animate={{opacity: 1, y: 0}}
                            exit={{opacity: 0}}
                            transition={tween('fast')}
                        >
                            <StatusLine status={status}/>
                        </StatusRow>
                    )}
                </AnimatePresence>
                {bar}
            </Footer>
        </>
    )
}
