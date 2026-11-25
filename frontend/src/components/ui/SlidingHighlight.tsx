import {type FocusEvent, useEffect, useState} from 'react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {springs, tween} from '@/styles/motion'

// The hover follows 0xUrvish's Smooth Dropdown on 21st.dev
// (https://21st.dev/@0xUrvish/components/smooth-dropdown): one highlight
// slides on a spring from item to item instead of each item lighting up on
// its own. It moves by transform (layoutId needs domMax, which is not loaded).

const Highlight = styled(m.span)`
    position: absolute;
    top: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: ${({theme}) => theme.colors.surface};
    pointer-events: none;
`

/**
 * What the highlight never slides across: a separator, and whatever is
 * marked with `data-highlight-divider` (a menu's group label). Sliding
 * would pass over it, and a label under the moving surface flickers.
 */
export const DIVIDER_SELECTOR = '[role="separator"], [data-highlight-divider]'

/** A divider lies between two items of `root`. */
function dividerBetween(root: Element, from: Element, to: Element): boolean {
    if (from === to) return false
    const [first, last] = from.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING ? [from, to] : [to, from]
    return [...root.querySelectorAll(DIVIDER_SELECTOR)].some((divider) =>
        first.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING
        && divider.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING)
}

interface Mark {
    /** The item it is on. */
    item: Element
    top: number
    left: number
    width: number
    height: number
    visible: boolean
    /**
     * Appearing after it was hidden, or reaching an item past a divider: it
     * lands on the item instead of sliding from where it last was.
     */
    jump: boolean
}

/**
 * A highlight that slides to the highlighted item of a Radix menu or select
 * list. Spread `handlers` (a ref and a focus handler) on the element around
 * the items, make the items' offset parent `position: relative`, give the
 * items `position: relative` so they paint above it, and render `highlight`
 * first, inside that parent.
 *
 * Radix highlights an item by focusing it, from the pointer or the arrow
 * keys, and focuses the list itself when the pointer leaves an item for a
 * separator or the padding. In the reference the hover then reset to
 * nothing, and the shared highlight flew to the active item and back while
 * the pointer crossed a divider. Here a focus that lands on no item leaves
 * the highlight on the last one, and the next item it reaches it lands on
 * at once: it never slides across a separator or a group label
 * (`DIVIDER_SELECTOR`). Only leaving the list or pointing at a disabled item
 * hides it.
 */
export function useSlidingHighlight(itemSelector: string) {
    const [mark, setMark] = useState<Mark | null>(null)
    const [list, setList] = useState<HTMLElement | null>(null)

    // A native listener: React builds onPointerLeave from pointerout and its
    // relatedTarget, and reads a missing one as leaving the window, which
    // would hide the highlight on the way across a divider.
    useEffect(() => {
        if (!list) return
        const leave = () => setMark((last) => last && {...last, visible: false})
        // Radix focuses the list, not a disabled item, under the pointer, so
        // the highlight would stay on the last item, where Enter does
        // nothing. It hides there, and lands on the next item it reaches.
        const over = (event: PointerEvent) => {
            const item = event.target instanceof Element ? event.target.closest(itemSelector) : null
            if (item?.hasAttribute('data-disabled')) leave()
        }
        list.addEventListener('pointerleave', leave)
        list.addEventListener('pointerover', over)
        return () => {
            list.removeEventListener('pointerleave', leave)
            list.removeEventListener('pointerover', over)
        }
    }, [list, itemSelector])

    const handlers = {
        ref: setList,
        onFocus: (event: FocusEvent<HTMLElement>) => {
            const item = (event.target as HTMLElement).closest<HTMLElement>(itemSelector)
            if (!item) return
            const root = event.currentTarget
            setMark((last) => ({
                item,
                top: item.offsetTop,
                left: item.offsetLeft,
                width: item.offsetWidth,
                height: item.offsetHeight,
                visible: true,
                jump: !last?.visible || dividerBetween(root, last.item, item),
            }))
        },
    }

    const highlight = (
        <Highlight
            aria-hidden
            data-visible={mark?.visible ?? false}
            // How it reached its item, for tests and the inspector: an animation ends at once there.
            data-move={mark?.jump ? 'land' : 'slide'}
            // Geometry from the item, in an inline style: it changes per item and must not make a class each.
            style={mark ? {left: mark.left, width: mark.width, height: mark.height} : undefined}
            initial={false}
            animate={{opacity: mark?.visible ? 1 : 0, y: mark?.top ?? 0}}
            transition={{y: mark?.jump ? {duration: 0} : springs.snappy, opacity: tween('fast')}}
        />
    )

    return {handlers, highlight}
}
