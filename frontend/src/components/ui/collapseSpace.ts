/**
 * The space a Collapse takes outside its own height, so its animation can
 * take that space too.
 *
 * Height alone misses two things. In a flex or grid column (a SettingsRow
 * lays out its line and what follows with a `gap`) the gap between the
 * Collapse and its neighbour stays at full size while the height is 0, and
 * goes only when the Collapse unmounts. A settings card's hairline is a
 * `border-top` on the Collapse itself, and a border-box never gets thinner
 * than its border. Both made the content snap by that much at the end of a
 * close and at the start of an open.
 */
export interface CollapseSpace {
    /** The parent's row gap that this element adds to the column. */
    gap: number
    /** The gap is before this element; the first item's gap is after it. */
    side: 'marginTop' | 'marginBottom'
    borderTop: number
    borderBottom: number
}

const px = (value: string) => parseFloat(value) || 0

/** Measured from the stylesheet, so read it before any inline style goes on. */
export function collapseSpace(element: HTMLElement): CollapseSpace {
    const own = getComputedStyle(element)
    const parent = element.parentElement
    let gap = 0
    if (parent && (element.previousElementSibling || element.nextElementSibling)) {
        const layout = getComputedStyle(parent)
        const column = layout.display.includes('grid')
            || (layout.display.includes('flex') && layout.flexDirection.startsWith('column'))
        if (column) gap = px(layout.rowGap)
    }
    return {
        gap,
        side: element.previousElementSibling ? 'marginTop' : 'marginBottom',
        borderTop: px(own.borderTopWidth),
        borderBottom: px(own.borderBottomWidth),
    }
}

/** Taking no space at all: no height, no border, and the gap pulled back in. */
export const closedStyle = (space: CollapseSpace) => ({
    height: 0,
    borderTopWidth: 0,
    borderBottomWidth: 0,
    [space.side]: -space.gap,
})

/** The layout's own size, which `element.scrollHeight` gives even while clipped. */
export const openStyle = (space: CollapseSpace, element: HTMLElement) => ({
    height: element.scrollHeight + space.borderTop + space.borderBottom,
    borderTopWidth: space.borderTop,
    borderBottomWidth: space.borderBottom,
    [space.side]: 0,
})
