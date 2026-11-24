import {useMemo} from 'react'
import {CaretDownIcon} from '@phosphor-icons/react'
import type {TranscriptSegment} from '@/api/meetings'
import {Button} from '@/components/ui/Button'
import {Menu, MenuItem, MenuSeparator} from '@/components/ui/Menu'
import {countSpeakers, SPEAKER_COUNTS, speakerCountLabel} from './identifySpeakers'

/** Automatic and the counts, as menu items; picking one starts the run. */
export function SpeakerCountItems({onPick}: { onPick: (count: number | null) => void }) {
    return (
        <>
            <MenuItem onSelect={() => onPick(null)}>Detect automatically</MenuItem>
            <MenuSeparator/>
            {SPEAKER_COUNTS.map((count) => (
                <MenuItem key={count} onSelect={() => onPick(count)}>{speakerCountLabel(count)}</MenuItem>
            ))}
        </>
    )
}

/**
 * "4 speakers ▾" in the Transcript tab's row: how many voices were found,
 * and a menu to find them again with another count.
 */
export function SpeakerCount({lines, onPick, running}: {
    lines: readonly TranscriptSegment[]
    onPick: (count: number | null) => void
    running: boolean
}) {
    const count = useMemo(() => countSpeakers(lines), [lines])
    if (count === 0) return null
    return (
        <Menu
            trigger={(
                <Button
                    size="sm"
                    pending={running}
                    aria-label={`${speakerCountLabel(count)} found. Change the count`}
                    title="Wrong count? Pick another and Protocol relabels the transcript"
                    trailing={<CaretDownIcon size={11} aria-hidden/>}
                >
                    {speakerCountLabel(count)}
                </Button>
            )}
        >
            <SpeakerCountItems onPick={onPick}/>
        </Menu>
    )
}
