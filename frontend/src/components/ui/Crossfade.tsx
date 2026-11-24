import type {ComponentProps, ReactElement} from 'react'
import {AnimatePresence, useIsPresent} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {tween} from '@/styles/motion'

// The leaving and the arriving view share one grid cell, so they crossfade
// in place; the area takes the taller one's height until the old one is gone.
const Stack = styled.div`
    display: grid;
    flex: 1;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-height: 0;
`

const View = styled(m.div)`
    grid-area: 1 / 1;
    min-height: 0;
`

type CrossfadeViewProps = Omit<ComponentProps<typeof View>, 'initial' | 'animate' | 'exit' | 'transition' | 'inert'>

/** One view of a Crossfade. Its other props (a role, an id, styles) go on its element. */
export function CrossfadeView(props: CrossfadeViewProps) {
    // A leaving view is out of reach while it fades: Tab never lands in it.
    const present = useIsPresent()
    return (
        <View
            inert={!present}
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            exit={{opacity: 0}}
            transition={tween('base')}
            {...props}
        />
    )
}

/**
 * Views that replace each other in one place: a tab's panel, Settings'
 * simple page and its sections. The child is a CrossfadeView (or renders
 * one) keyed by the view it shows; a new key crossfades with the old over
 * `base`, without sliding.
 */
export function Crossfade({children}: {children: ReactElement}) {
    return (
        <Stack>
            <AnimatePresence initial={false}>{children}</AnimatePresence>
        </Stack>
    )
}
