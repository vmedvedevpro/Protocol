import {useLayoutEffect, useRef, useState} from 'react'
import {DotsThreeIcon, PencilSimpleIcon, PlusIcon, TrashIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import type {Folder} from '@/api/meetings'
import {IconButton} from '@/components/ui/Button'
import {Menu, MenuItem} from '@/components/ui/Menu'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {Tooltip} from '@/components/ui/Tooltip'
import {springs, tween} from '@/styles/motion'

const Bar = styled.div`
    position: relative;
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
`

// The thumb under the selected chip is the only filled shape; hover changes
// the text alone. Chips paint above the thumb.
const Chip = styled.button<{ $selected: boolean }>`
    position: relative;
    max-width: 100%;
    height: ${({theme}) => theme.sizes.chip};
    padding: 0 ${({theme}) => theme.space[2.5]};
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: ${({theme}) => theme.radii.sm};
    background: transparent;
    color: ${({theme, $selected}) => ($selected ? theme.colors.text : theme.colors.muted)};
    ${({theme}) => theme.text.label};
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }
`

// The selected chip's outline and fill, moved by transform to the chip
// chosen, as SegmentedControl's thumb is. Chips differ in width, so its size
// follows the chip's on the same spring (UI_ARCHITECTURE › Motion: the one
// size that animates besides Collapse; a scale would stretch its rounded ends).
const Thumb = styled(m.span)`
    position: absolute;
    top: 0;
    left: 0;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.raised};
    pointer-events: none;
`

interface ThumbBox {
    x: number
    y: number
    width: number
    height: number
}

/** Where the thumb goes: the selected chip's box in the bar, measured again when the bar's size changes. */
function useThumb(selected: string | null, folders: readonly Folder[]) {
    const bar = useRef<HTMLDivElement>(null)
    const [box, setBox] = useState<ThumbBox | null>(null)
    useLayoutEffect(() => {
        const element = bar.current
        if (!element) return
        const measure = () => {
            const chip = element.querySelector<HTMLElement>('[aria-pressed="true"]')
            setBox(chip && {x: chip.offsetLeft, y: chip.offsetTop, width: chip.offsetWidth, height: chip.offsetHeight})
        }
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        measure()
        return () => observer.disconnect()
    }, [selected, folders])
    return {bar, box}
}

const NewChip = styled.button`
    display: flex;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.chip};
    height: ${({theme}) => theme.sizes.chip};
    padding: 0;
    border: 1px dashed ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.sm};
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover {
        border-color: ${({theme}) => theme.colors.muted};
        color: ${({theme}) => theme.colors.text};
    }
`

// The folder actions button's place after New folder. It stays while All is
// selected, so choosing a folder moves nothing: the chips wrap the same with
// the button or without it, and the slot is a chip's size, which the 28 px
// button overflows evenly instead of making the row 2 px taller than its
// 26 px chips.
const ActionsSlot = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.chip};
    height: ${({theme}) => theme.sizes.chip};
`

// An icon with no text, so it may fade (UI_ARCHITECTURE › Motion), as the
// title bar's Back button does.
const Appear = styled(m.span)`
    display: flex;
`

const appear = {
    initial: {opacity: 0},
    animate: {opacity: 1},
    exit: {opacity: 0},
    transition: tween('fast'),
}

interface FolderBarProps {
    folders: readonly Folder[]
    /** The folder the list shows, or null for all meetings. */
    selected: string | null
    onSelect: (folderId: string | null) => void
    onNew: () => void
    onRename: (folder: Folder) => void
    onDelete: (folder: Folder) => void
}

/**
 * The folders as a filter over the list (the old Groups page): All, each
 * folder, and New folder. The selected folder's actions, rename and delete,
 * sit in a menu after the chips.
 */
export function FolderBar({folders, selected, onSelect, onNew, onRename, onDelete}: FolderBarProps) {
    const current = folders.find((folder) => folder.id === selected)
    const {bar, box} = useThumb(selected, folders)
    return (
        <Bar ref={bar} role="group" aria-label="Folders">
            {/* Mounted at its first place without moving; from there it slides. */}
            {box && (
                <Thumb
                    aria-hidden
                    data-testid="folder-thumb"
                    initial={false}
                    animate={{x: box.x, y: box.y, width: box.width, height: box.height}}
                    transition={springs.snappy}
                />
            )}
            <Chip type="button" aria-pressed={!current} $selected={!current} onClick={() => onSelect(null)}>All</Chip>
            {folders.map((folder) => (
                <Tooltip key={folder.id} content={`${folder.name}: ${folder.meetingCount} ${folder.meetingCount === 1 ? 'meeting' : 'meetings'}`}>
                    <Chip
                        type="button"
                        aria-pressed={folder.id === selected}
                        $selected={folder.id === selected}
                        onClick={() => onSelect(folder.id)}
                    >
                        {folder.name}
                    </Chip>
                </Tooltip>
            ))}
            <Tooltip content="New folder">
                <NewChip type="button" aria-label="New folder" onClick={onNew}>
                    <PlusIcon size={12} aria-hidden/>
                </NewChip>
            </Tooltip>
            <ActionsSlot data-testid="folder-actions">
                <AnimatePresence initial={false}>
                    {current && (
                        <Appear key="actions" {...appear}>
                            <Menu
                                trigger={(
                                    <IconButton label={`Folder actions: ${current.name}`}>
                                        <DotsThreeIcon aria-hidden/>
                                    </IconButton>
                                )}
                                align="start"
                            >
                                <MenuItem icon={<PencilSimpleIcon aria-hidden/>} onSelect={() => onRename(current)}>Rename folder…</MenuItem>
                                <MenuItem icon={<TrashIcon aria-hidden/>} onSelect={() => onDelete(current)}>Delete folder…</MenuItem>
                            </Menu>
                        </Appear>
                    )}
                </AnimatePresence>
            </ActionsSlot>
        </Bar>
    )
}
