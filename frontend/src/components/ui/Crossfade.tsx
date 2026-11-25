import type {ComponentProps, ReactElement} from 'react'
import {AnimatePresence, useIsPresent} from 'motion/react'
import styled from 'styled-components'
import {Veil} from './Veil'

// The leaving and the arriving view share one grid cell, so they swap in
// place; the area takes the taller one's height until the old one is gone.
const Stack = styled.div`
    display: grid;
    flex: 1;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-height: 0;
`

const View = styled.div`
    position: relative;
    grid-area: 1 / 1;
    min-height: 0;
`

type CrossfadeViewProps = Omit<ComponentProps<typeof View>, 'inert'>

/** One view of a Crossfade. Its other props (a role, an id, styles) go on its element. */
export function CrossfadeView({children, ...props}: CrossfadeViewProps) {
    // A leaving view is out of reach while it is veiled: Tab never lands in it.
    const present = useIsPresent()
    return (
        <View inert={!present} {...props}>
            {children}
            <Veil/>
        </View>
    )
}

/**
 * Views that replace each other in one place: a tab's panel, Settings'
 * simple page and its sections. The child is a CrossfadeView (or renders
 * one) keyed by the view it shows; on a new key the old view is veiled and
 * the new one revealed over `base` (Veil), without sliding.
 */
export function Crossfade({children}: {children: ReactElement}) {
    return (
        <Stack>
            <AnimatePresence initial={false}>{children}</AnimatePresence>
        </Stack>
    )
}
