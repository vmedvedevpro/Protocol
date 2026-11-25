import {useCallback, useEffect, useMemo, useState} from 'react'
import {ArrowElbowDownLeftIcon, GearIcon, MagnifyingGlassIcon} from '@phosphor-icons/react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import * as m from 'motion/react-m'
import {useNavigate, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {actionItemKeys} from '@/api/actionItems'
import {type Folder, foldersQuery, type MeetingListItem, meetingsQuery} from '@/api/meetings'
import {updaterStatusQuery} from '@/api/updater'
import {Screen} from '@/components/screen/Screen'
import {Button, IconButton} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {Kbd} from '@/components/ui/Kbd'
import {Spinner} from '@/components/ui/Spinner'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {TextField} from '@/components/ui/TextField'
import {Veil} from '@/components/ui/Veil'
import {openDialog} from '@/lib/dialogs'
import {paths} from '@/lib/paths'
import {formatShortcut} from '@/lib/platform'
import {openSearch} from '@/lib/searchLauncher'
import {tween} from '@/styles/motion'
import {RenameMeetingSheet} from '../components/RenameMeetingSheet'
import {backfillActionItems} from '../lib/actionItemSync'
import {FolderBar} from './FolderBar'
import {DeleteFolderSheet, FolderNameSheet} from '../components/FolderSheets'
import {MeetingList} from './MeetingList'
import {needsPermissionBanner, useAudioAccess} from './audioAccess'
import {PermissionBanner} from './PermissionBanner'
import {readyOffer} from '../lib/updates'
import {UpdateBanner} from './UpdateBanner'
import {useMissingSummaryModel} from './missingSummaryModel'
import {SummaryModelBanner} from './SummaryModelBanner'

const Head = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[4]};
`

const Title = styled.h1`
    flex: 1;
    min-width: 0;
    margin: 0;
    ${({theme}) => theme.text.screen};
`

const Search = styled.div`
    flex: none;
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
`

const Empty = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({theme}) => theme.space[2]};
    min-height: 0;
    padding: ${({theme}) => theme.space[6]} ${({theme}) => theme.space[9]} ${({theme}) => theme.space[9]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
    text-align: center;
`

const EmptyTitle = styled.p`
    margin: 0;
    ${({theme}) => theme.text.heading};
`

const Muted = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.muted};
`

const ImportButton = styled(Button)`
    margin-top: ${({theme}) => theme.space[1.5]};
`

const NoMatch = styled(Muted)`
    padding: ${({theme}) => theme.space[6]} ${({theme}) => theme.space[4]};
    text-align: center;
`

// Under the filtered list while the field has a query: the same words in
// transcripts, summaries, action items and people, through search (#118).
const Everywhere = styled(m.button)`
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2.5]};
    margin: 0 ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    ${({theme}) => theme.text.body};
    text-align: left;
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }

    > span {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    &:hover {
        background: ${({theme}) => theme.colors.surface};
    }
`

const matches = (text: string | undefined, query: string) => !!text && text.toLowerCase().includes(query)

/**
 * Home: the meetings list. Search filters it by title and folder as the
 * user types; Enter, or the row under the list, takes the words to search
 * (⌘K), which looks in transcripts, summaries, action items and people
 * too. The folder chips filter it
 * by folder, kept in the URL (`?folder=`), so Back from a meeting returns
 * to the same folder. Banners say when an update waits for a restart,
 * when Protocol cannot hear the microphone or the computer audio, and when
 * the built-in summary model is not downloaded. The
 * recording bar docks below (`recordBar`).
 */
export function HomeScreen() {
    const navigate = useNavigate()
    const client = useQueryClient()
    const [params, setParams] = useSearchParams()
    const meetings = useQuery(meetingsQuery)
    const folders = useQuery(foldersQuery)
    const updater = useQuery(updaterStatusQuery)
    const access = useAudioAccess()
    const [query, setQuery] = useState('')

    // Each sheet keeps what it was opened for while it closes, so its
    // text does not change during the exit.
    const [naming, setNaming] = useState<{ open: boolean, folder: Folder | null }>({open: false, folder: null})
    const [deleting, setDeleting] = useState<{ open: boolean, folder: Folder | null }>({open: false, folder: null})
    const [renaming, setRenaming] = useState<{ open: boolean, meeting: MeetingListItem | null }>({open: false, meeting: null})

    // Summaries written by versions before action items were rows, read once per session.
    useEffect(() => {
        void backfillActionItems().then((changed) => {
            if (changed > 0) void client.invalidateQueries({queryKey: actionItemKeys.all})
        })
    }, [client])

    const folderList = useMemo(() => folders.data ?? [], [folders.data])
    const requested = params.get('folder')
    // A folder that was deleted, or never existed, shows everything.
    const folderId = requested && folderList.some((folder) => folder.id === requested) ? requested : null
    const selectFolder = useCallback((id: string | null) => {
        setParams((current) => {
            const next = new URLSearchParams(current)
            if (id) next.set('folder', id)
            else next.delete('folder')
            return next
        }, {replace: true})
    }, [setParams])

    const needle = query.trim().toLowerCase()
    const names = useMemo(() => new Map(folderList.map((folder) => [folder.id, folder.name])), [folderList])
    // Stable, so the memoized rows render again only when they change.
    const renameMeeting = useCallback((meeting: MeetingListItem) => setRenaming({open: true, meeting}), [])
    const shows = useCallback((meeting: MeetingListItem) =>
        (!folderId || meeting.group_id === folderId) &&
        (!needle || matches(meeting.title, needle) || matches(meeting.group_id ? names.get(meeting.group_id) : undefined, needle)),
    [folderId, needle, names])

    const offer = readyOffer(updater.data)
    const showPermission = needsPermissionBanner(access)
    const missingSummaryModel = useMissingSummaryModel()
    const none = meetings.isSuccess && meetings.data.length === 0

    return (
        <Screen recordBar>
            <Head>
                <Title>Meetings</Title>
                <IconButton label="Settings" shortcut={formatShortcut(',')} onClick={() => void navigate(paths.settings())}>
                    <GearIcon size={17}/>
                </IconButton>
            </Head>
            {!none && (
                <Search>
                    <TextField
                        type="search"
                        tone="soft"
                        aria-label="Search meetings"
                        placeholder="Search meetings and transcripts"
                        icon={<MagnifyingGlassIcon aria-hidden/>}
                        trailing={<Kbd tone="raised" aria-hidden>{formatShortcut('K')}</Kbd>}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape' && query) {
                                event.preventDefault()
                                setQuery('')
                            } else if (event.key === 'Enter') {
                                event.preventDefault()
                                openSearch(query)
                            }
                        }}
                    />
                </Search>
            )}
            {/* A banner's slot opens and closes with it, so the list below slides. */}
            <Collapse open={!!offer && !!updater.data}>
                {offer && updater.data ? <UpdateBanner snapshot={updater.data} offer={offer}/> : null}
            </Collapse>
            <Collapse open={showPermission && !!access}>
                {showPermission && access ? <PermissionBanner access={access}/> : null}
            </Collapse>
            <Collapse open={!!missingSummaryModel}>
                {missingSummaryModel ? <SummaryModelBanner model={missingSummaryModel}/> : null}
            </Collapse>
            {meetings.isPending && <Empty aria-busy="true"><Spinner delayed/></Empty>}
            {meetings.isError && (
                <Empty role="alert">
                    <EmptyTitle>Couldn’t load your meetings</EmptyTitle>
                    <Muted>{meetings.error.message}</Muted>
                    <Button size="sm" onClick={() => void meetings.refetch()}>Try again</Button>
                </Empty>
            )}
            {none && (
                <Empty>
                    <EmptyTitle>No meetings yet</EmptyTitle>
                    <Muted>Press Record when a call starts. The notes, transcript and summary show up here.</Muted>
                    <ImportButton onClick={() => openDialog({kind: 'import'})}>Import a recording</ImportButton>
                </Empty>
            )}
            {meetings.isSuccess && !none && (
                <>
                    <FolderBar
                        folders={folderList}
                        selected={folderId}
                        onSelect={selectFolder}
                        onNew={() => setNaming({open: true, folder: null})}
                        onRename={(folder) => setNaming({open: true, folder})}
                        onDelete={(folder) => setDeleting({open: true, folder})}
                    />
                    <MeetingList
                        meetings={meetings.data}
                        shows={shows}
                        folderNames={names}
                        onRename={renameMeeting}
                        empty={(
                            <NoMatch>
                                {needle ? `No meetings match “${query.trim()}”.` : 'No meetings in this folder yet.'}
                            </NoMatch>
                        )}
                    />
                    {/* Text never fades: it rises under a veil, and goes at once when the query is cleared. */}
                    {needle && (
                        <Everywhere
                            key="everywhere"
                            type="button"
                            initial={{y: 4}}
                            animate={{y: 0}}
                            transition={tween('base', 'enter')}
                            onClick={() => openSearch(query)}
                        >
                            <MagnifyingGlassIcon aria-hidden/>
                            <span>Search transcripts, summaries and people for “{query.trim()}”</span>
                            <ArrowElbowDownLeftIcon aria-hidden/>
                            <Veil/>
                        </Everywhere>
                    )}
                </>
            )}
            <FolderNameSheet
                open={naming.open}
                onOpenChange={(open) => setNaming((current) => ({...current, open}))}
                folder={naming.folder}
                onCreated={(folder) => selectFolder(folder.id)}
            />
            <DeleteFolderSheet
                open={deleting.open}
                folder={deleting.folder}
                onOpenChange={(open) => setDeleting((current) => ({...current, open}))}
                onDeleted={(folder) => folder.id === folderId && selectFolder(null)}
            />
            <RenameMeetingSheet
                open={renaming.open}
                meeting={renaming.meeting}
                onOpenChange={(open) => setRenaming((current) => ({...current, open}))}
            />
        </Screen>
    )
}
