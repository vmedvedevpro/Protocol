import type {ReactNode} from 'react'
import styled from 'styled-components'
import {VisuallyHidden} from './VisuallyHidden'

// The parts wrap as whole parts when the line runs out of room, a long
// one breaking inside itself rather than overflowing; nothing is cut.
const Line = styled.span`
    display: flex;
    flex-wrap: wrap;
    column-gap: ${({theme}) => theme.space[2.5]};
    min-width: 0;
`

// An icon at a part's start (a folder's) sits on the text's line.
const Part = styled.span`
    position: relative;
    min-width: 0;
    overflow-wrap: anywhere;

    > svg {
        margin-right: ${({theme}) => theme.space[1]};
        vertical-align: -0.125em;
    }
`

type PartContent = ReactNode | false | null | undefined

/**
 * Parts of one line that do not read as one phrase, such as a meeting's
 * date, length and folder: set apart by spacing, never joined with "·"
 * (#219), and wrapping whole when the line is too narrow. Empty parts are
 * left out. Assistive technology and copied text
 * get a comma between them, which the eye does not see. The line takes
 * the text style of the element it is put in.
 */
export function SpacedParts({parts, className}: { parts: PartContent[], className?: string }) {
    const shown = parts.filter((part) => part !== false && part !== null && part !== undefined && part !== '')
    return (
        <Line className={className}>
            {/* The comma ends the part before it, so copied text reads "a, b". */}
            {shown.map((part, index) => (
                <Part key={index}>
                    {part}
                    {index < shown.length - 1 && <VisuallyHidden>, </VisuallyHidden>}
                </Part>
            ))}
        </Line>
    )
}
