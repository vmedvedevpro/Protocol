import {type FormEvent, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {CaretDownIcon, CopyIcon, DotsThreeIcon, FolderIcon, GearIcon} from '@phosphor-icons/react'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {foldersQuery} from '@/api/meetings'
import {IconButton} from '@/components/ui/Button'
import {Menu, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem} from '@/components/ui/Menu'
import {focusRing} from '@/components/ui/styles'
import {toast} from '@/components/ui/toastStore'
import {Tooltip} from '@/components/ui/Tooltip'
import {paths} from '@/lib/paths'
import {transcriptText} from '../api/transcript'
import {startedLabel} from '../lib/titles'
import {renameRecording, setFolder} from '../store/runtime'
import {useSessionStore} from '../store/session'

const Head = styled.div`
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[1]};
    padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2]} ${({theme}) => theme.space[4]};
`

const Titles = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: ${({theme}) => theme.space[0.5]};
    min-width: 0;
`

const Title = styled.h1`
    overflow: hidden;
    ${({theme}) => theme.text.screen};
    text-overflow: ellipsis;
    white-space: nowrap;
`

// The title is the rename control while recording.
const TitleButton = styled.button`
    max-width: 100%;
    overflow: hidden;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;

    ${focusRing};
`

// Takes the title's place and size while renaming.
const TitleInput = styled.input`
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: inherit;
    ${({theme}) => theme.text.screen};
    outline: none;

    ${focusRing};
`

const Sub = styled.p`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const FolderButton = styled.button`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[0.5]};
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;

    &:hover:not(:disabled) {
        color: ${({theme}) => theme.colors.text};
    }

    &:disabled {
        cursor: default;
    }

    ${focusRing};
`

const NO_FOLDER = ''

/** The live transcript so far, one turn a line, for pasting elsewhere. */
async function copyTranscript() {
    try {
        await navigator.clipboard.writeText(transcriptText(useSessionStore.getState().lines))
        toast.success('Transcript copied', {id: 'copy-transcript'})
    } catch {
        toast.error('Could not copy the transcript', {id: 'copy-transcript'})
    }
}

/** Files the meeting in a folder when it is saved; picked while recording, shown but fixed while saving. */
function FolderPicker({disabled}: { disabled: boolean }) {
    const folder = useSessionStore((state) => state.folder)
    const folders = useQuery(foldersQuery)
    const name = folder?.name ?? 'No folder'

    return (
        <Menu
            align="start"
            trigger={(
                <FolderButton type="button" disabled={disabled} aria-label={`Folder: ${name}. Change`}>
                    {name}
                    <CaretDownIcon size={10} aria-hidden="true"/>
                </FolderButton>
            )}
        >
            <MenuGroup label="Save in">
                <MenuRadioGroup
                    value={folder?.id ?? NO_FOLDER}
                    onValueChange={(id) => {
                        const picked = folders.data?.find((each) => each.id === id)
                        setFolder(picked ? {id: picked.id, name: picked.name} : null)
                    }}
                >
                    <MenuRadioItem value={NO_FOLDER}>No folder</MenuRadioItem>
                    {folders.data?.map((each) => <MenuRadioItem key={each.id} value={each.id}>{each.name}</MenuRadioItem>)}
                </MenuRadioGroup>
            </MenuGroup>
        </Menu>
    )
}

/**
 * The recording screen's header: the title (renamed in place), when it
 * started and the folder it is saved in, and More actions.
 */
export function RecordingHeader() {
    const navigate = useNavigate()
    const title = useSessionStore((state) => state.title)
    const startedAt = useSessionStore((state) => state.startedAt)
    const phase = useSessionStore((state) => state.phase)
    const [draft, setDraft] = useState<string | null>(null)
    const live = phase === 'recording' || phase === 'paused'

    const submit = (event?: FormEvent) => {
        event?.preventDefault()
        if (draft !== null) renameRecording(draft)
        setDraft(null)
    }

    return (
        <Head>
            <Titles>
                {draft === null ? (
                    <Title>
                        {live ? (
                            <Tooltip content="Rename">
                                <TitleButton type="button" onClick={() => setDraft(title)}>{title || 'Recording'}</TitleButton>
                            </Tooltip>
                        ) : phase === 'finishing' ? title || 'Recording' : 'Recording'}
                    </Title>
                ) : (
                    <form onSubmit={submit}>
                        <h1>
                            <TitleInput
                                aria-label="Title"
                                value={draft}
                                autoFocus
                                maxLength={200}
                                onChange={(event) => setDraft(event.target.value)}
                                onBlur={() => submit()}
                                onKeyDown={(event) => {
                                    if (event.key === 'Escape') {
                                        event.stopPropagation()
                                        setDraft(null)
                                    }
                                }}
                            />
                        </h1>
                    </form>
                )}
                {/* Kept while the save runs, so the header does not jump at Stop. */}
                {(live || phase === 'finishing') && startedAt && (
                    <Sub>
                        <span>{startedLabel(new Date(startedAt))}</span>
                        <span aria-hidden="true">·</span>
                        <FolderIcon size={12} aria-hidden="true"/>
                        <FolderPicker disabled={!live}/>
                    </Sub>
                )}
            </Titles>
            <Menu
                trigger={(
                    <IconButton label="More actions">
                        <DotsThreeIcon size={17} weight="bold"/>
                    </IconButton>
                )}
            >
                <MenuItem icon={<CopyIcon size={15}/>} disabled={!live} onSelect={() => void copyTranscript()}>Copy transcript</MenuItem>
                <MenuItem icon={<GearIcon size={15}/>} onSelect={() => void navigate(paths.settings('recording'))}>Recording settings</MenuItem>
            </Menu>
        </Head>
    )
}
