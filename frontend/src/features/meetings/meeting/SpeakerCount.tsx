import {useMemo} from 'react'
import styled from 'styled-components'
import type {TranscriptSegment} from '@/api/meetings'
import {Button} from '@/components/ui/Button'
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
 * "4 speakers · Identify speakers…" in the Transcript tab's row: how many
 * voices were found, and a button that opens the Identify speakers sheet,
 * where the user picks a count and confirms before anything is relabelled.
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
            <Button size="sm" pending={running} onClick={onIdentify}>Identify speakers…</Button>
        </Wrap>
    )
}
