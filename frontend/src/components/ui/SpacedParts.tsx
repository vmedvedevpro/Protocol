import type {ReactNode} from 'react'
import styled from 'styled-components'
import {VisuallyHidden} from './VisuallyHidden'

// One line: the parts keep their width and the last one is cut with an
// ellipsis when the line runs out of room.
const Line = styled.span`
    display: flex;
    gap: ${({theme}) => theme.space[2.5]};
    min-width: 0;
    white-space: nowrap;

    > span {
        position: relative;
        flex: none;
    }

    > span:last-child {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }
`

// A flex item, so a plain block: the ellipsis needs one. An icon at a
// part's start (a folder's) sits on the text's line.
const Part = styled.span`
    > svg {
        margin-right: ${({theme}) => theme.space[1]};
        vertical-align: -0.125em;
    }
`

type PartContent = ReactNode | false | null | undefined

/**
 * Parts of one line that do not read as one phrase, such as a meeting's
 * date, length and folder: set apart by spacing, never joined with "·"
 * (#219). Empty parts are left out. Assistive technology and copied text
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
