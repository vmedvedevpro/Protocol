import {
    CopyIcon,
    DotsThreeIcon,
    ExportIcon,
    FolderOpenIcon,
    FolderSimpleIcon,
    MagicWandIcon,
    PencilSimpleIcon,
    TrashIcon,
    UsersIcon,
} from '@phosphor-icons/react'
import {useLayoutEffect, useRef, useState} from 'react'
import styled from 'styled-components'
import type {Folder} from '@/api/meetings'
import {IconButton} from '@/components/ui/Button'
import {Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub} from '@/components/ui/Menu'
import {Tooltip} from '@/components/ui/Tooltip'
import {formatLength, headerWhen} from '../lib/dates'
import {SpeakerCountItems} from './SpeakerCount'

const Head = styled.div`
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]};
`

const Text = styled.div`
    flex: 1;
    min-width: 0;
`

const Title = styled.h1`
    margin: 0;
    overflow: hidden;
    ${({theme}) => theme.text.screen};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Meta = styled.p`
    margin: 0;
    overflow: hidden;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    white-space: nowrap;
    text-overflow: ellipsis;
`

/** The title on one line; cut off, it shows whole in a tooltip. */
function MeetingTitle({title}: { title: string }) {
    const heading = useRef<HTMLHeadingElement>(null)
    const [cut, setCut] = useState(false)
    useLayoutEffect(() => {
        const element = heading.current
        if (!element) return
        const measure = () => setCut(element.scrollWidth > element.clientWidth)
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
    }, [title])
    const shown = <Title ref={heading}>{title}</Title>
    return cut ? <Tooltip content={title}>{shown}</Tooltip> : shown
}

// The radio group's value for "No folder"; folder ids are UUIDs.
const NO_FOLDER = ''

export interface MeetingHeaderProps {
    title: string
    createdAt: Date | null
    durationSeconds?: number
    folder: Folder | null
    folders: readonly Folder[]
    /** The meeting has a recording folder to open. */
    hasRecordingFolder: boolean
    hasSummary: boolean
    /** Identify speakers again is offered (an engine, audio, no pass running). */
    canIdentifySpeakers: boolean
    /** Improve the transcript is offered (audio, no pass running). */
    canImprove: boolean
    onRename: () => void
    onMove: (folderId: string | null) => void
    onNewFolder: () => void
    onCopyTranscript: () => void
    onCopySummary: () => void
    onExport: () => void
    onImprove: () => void
    onOpenRecordingFolder: () => void
    onIdentifySpeakers: (count: number | null) => void
    onDelete: () => void
}

/**
 * The meeting's title, when it was and how long, its folder, and the
 * meeting menu. The dialogs it opens (Export…, Improve the transcript…)
 * are features/dialogs' (#119).
 */
export function MeetingHeader(props: MeetingHeaderProps) {
    const {title, createdAt, durationSeconds, folder, folders} = props
    const meta = [
        createdAt && headerWhen(createdAt),
        durationSeconds ? formatLength(durationSeconds) : null,
        folder?.name,
    ].filter(Boolean).join(' · ')

    return (
        <Head>
            <Text>
                <MeetingTitle title={title}/>
                {meta && <Meta>{meta}</Meta>}
            </Text>
            <Menu
                trigger={(
                    <IconButton label="More actions: rename, move to folder, copy, export, delete">
                        <DotsThreeIcon size={17} aria-hidden/>
                    </IconButton>
                )}
            >
                <MenuItem icon={<PencilSimpleIcon aria-hidden/>} shortcut="F2" onSelect={props.onRename}>Rename…</MenuItem>
                <MenuSub label="Move to folder" icon={<FolderSimpleIcon aria-hidden/>}>
                    <MenuRadioGroup value={folder?.id ?? NO_FOLDER} onValueChange={(id) => props.onMove(id === NO_FOLDER ? null : id)}>
                        <MenuRadioItem value={NO_FOLDER}>No folder</MenuRadioItem>
                        {folders.map((item) => <MenuRadioItem key={item.id} value={item.id}>{item.name}</MenuRadioItem>)}
                    </MenuRadioGroup>
                    <MenuSeparator/>
                    <MenuItem onSelect={props.onNewFolder}>New folder…</MenuItem>
                </MenuSub>
                <MenuSeparator/>
                <MenuItem icon={<CopyIcon aria-hidden/>} onSelect={props.onCopyTranscript}>Copy transcript</MenuItem>
                <MenuItem icon={<CopyIcon aria-hidden/>} disabled={!props.hasSummary} onSelect={props.onCopySummary}>Copy summary</MenuItem>
                <MenuItem icon={<ExportIcon aria-hidden/>} onSelect={props.onExport}>Export…</MenuItem>
                {props.hasRecordingFolder && (
                    <MenuItem icon={<FolderOpenIcon aria-hidden/>} onSelect={props.onOpenRecordingFolder}>Open recording folder</MenuItem>
                )}
                {(props.canImprove || props.canIdentifySpeakers) && <MenuSeparator/>}
                {props.canImprove && (
                    <MenuItem icon={<MagicWandIcon aria-hidden/>} onSelect={props.onImprove}>Improve the transcript…</MenuItem>
                )}
                {props.canIdentifySpeakers && (
                    <>
                        <MenuSub label="Identify speakers again" icon={<UsersIcon aria-hidden/>}>
                            <SpeakerCountItems onPick={props.onIdentifySpeakers}/>
                        </MenuSub>
                    </>
                )}
                <MenuSeparator/>
                <MenuItem icon={<TrashIcon aria-hidden/>} onSelect={props.onDelete}>Delete…</MenuItem>
            </Menu>
        </Head>
    )
}
