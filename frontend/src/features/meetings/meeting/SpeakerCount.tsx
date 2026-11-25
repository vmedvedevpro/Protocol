import {useMemo} from 'react'
import {UsersIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import type {TranscriptSegment} from '@/api/meetings'
import {IconButton} from '@/components/ui/Button'
import {Spinner} from '@/components/ui/Spinner'
import {countSpeakers, speakerCountLabel} from './identifySpeakers'

const Wrap = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};

    > span {
        ${({theme}) => theme.text.small};
        color: ${({theme}) => theme.colors.muted};
        white-space: nowrap;
    }
`

/**
 * "4 speakers" and a button in the Transcript tab's row: how many voices
 * were found, and Identify speakers…, which opens the sheet where the user
 * picks a count and confirms before anything is relabelled. The button has
 * only an icon (the menu's Identify speakers again uses the same) and its
 * name as the tooltip: with its text the row ran past the 460 px window.
 * While a run goes it turns and waits.
 */
export function SpeakerCount({lines, onIdentify, running}: {
    lines: readonly TranscriptSegment[]
    onIdentify: () => void
    running: boolean
}) {
    const count = useMemo(() => countSpeakers(lines), [lines])
    if (count === 0) return null
    return (
        <Wrap>
            <span>{speakerCountLabel(count)}</span>
            <IconButton label="Identify speakers…" disabled={running} aria-busy={running || undefined} onClick={onIdentify}>
                {running ? <Spinner size={15}/> : <UsersIcon size={15} aria-hidden/>}
            </IconButton>
        </Wrap>
    )
}
