import type {ComponentProps, ReactElement} from 'react'
import {AnimatePresence, useIsPresent} from 'motion/react'
import styled from 'styled-components'
import {Veil} from './Veil'

// The leaving and the arriving view share one grid cell, so they swap in
// place; the area takes the taller one's height until the old one is gone.
// The leaving one stays until its veil has covered it, out of sight.
// Isolated, so the views' z-index orders them only against each other: on
// the page's root stacking context a view at z-index 1 painted over every
// portal (a Sheet, a Menu, a Tooltip), which sits at z-index auto.
const Stack = styled.div`
    isolation: isolate;
    display: grid;
    flex: 1;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-height: 0;
`

// The view that stays is drawn over the one that leaves, on the colour behind
// both, so the leaving view is covered at once and only the new one's reveal
// shows. Transparent, the old view showed through the arriving veil: mid-swap
// both were half there, and whatever the two views share (Settings' groups,
// a tab row's offset) stood twice at two heights. On top while present, so a
// view brought back before the other has left is not hidden under it.
const View = styled.div<{ $present: boolean }>`
    position: relative;
    z-index: ${({$present}) => ($present ? 1 : 0)};
    grid-area: 1 / 1;
    min-height: 0;
    background: var(--surface, ${({theme}) => theme.colors.bg});
`

type CrossfadeViewProps = Omit<ComponentProps<typeof View>, 'inert' | '$present'>

/** One view of a Crossfade. Its other props (a role, an id, styles) go on its element. */
export function CrossfadeView({children, ...props}: CrossfadeViewProps) {
    // A leaving view is out of reach while it is veiled: Tab never lands in it.
    const present = useIsPresent()
    return (
        <View inert={!present} $present={present} {...props}>
            {children}
            <Veil/>
        </View>
    )
}

/**
 * Views that replace each other in one place: a tab's panel, Settings'
 * simple page and its sections. The child is a CrossfadeView (or renders
 * one) keyed by the view it shows; on a new key the new view covers the
 * old one and is revealed over `base` (Veil), without sliding.
 */
export function Crossfade({children}: {children: ReactElement}) {
    return (
        <Stack>
            <AnimatePresence initial={false}>{children}</AnimatePresence>
        </Stack>
    )
}
