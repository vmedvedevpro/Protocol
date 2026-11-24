import {DotsThreeIcon, PencilSimpleIcon, PlusIcon, TrashIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import type {Folder} from '@/api/meetings'
import {IconButton} from '@/components/ui/Button'
import {Menu, MenuItem} from '@/components/ui/Menu'
import {colorTransition, focusRing} from '@/components/ui/styles'

const Bar = styled.div`
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
`

// The selected chip is the only filled one; hover changes the text alone.
const Chip = styled.button<{ $selected: boolean }>`
    max-width: 100%;
    height: ${({theme}) => theme.sizes.chip};
    padding: 0 ${({theme}) => theme.space[2.5]};
    overflow: hidden;
    border: 1px solid ${({theme, $selected}) => ($selected ? theme.colors.border : 'transparent')};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme, $selected}) => ($selected ? theme.colors.raised : 'transparent')};
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
    return (
        <Bar role="group" aria-label="Folders">
            <Chip type="button" aria-pressed={!current} $selected={!current} onClick={() => onSelect(null)}>All</Chip>
            {folders.map((folder) => (
                <Chip
                    key={folder.id}
                    type="button"
                    aria-pressed={folder.id === selected}
                    $selected={folder.id === selected}
                    title={`${folder.name}: ${folder.meetingCount} ${folder.meetingCount === 1 ? 'meeting' : 'meetings'}`}
                    onClick={() => onSelect(folder.id)}
                >
                    {folder.name}
                </Chip>
            ))}
            <NewChip type="button" aria-label="New folder" title="New folder" onClick={onNew}>
                <PlusIcon size={12} aria-hidden/>
            </NewChip>
            {current && (
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
            )}
        </Bar>
    )
}
