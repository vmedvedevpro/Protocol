import {useCallback, useEffect, useMemo, useState} from 'react'
import {GearIcon, MagnifyingGlassIcon} from '@phosphor-icons/react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import {useNavigate, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {actionItemKeys} from '@/api/actionItems'
import {type Folder, foldersQuery, type MeetingListItem, meetingsQuery} from '@/api/meetings'
import {updaterStatusQuery} from '@/api/updater'
import {Screen} from '@/components/screen/Screen'
import {Button, IconButton} from '@/components/ui/Button'
import {Spinner} from '@/components/ui/Spinner'
import {TextField} from '@/components/ui/TextField'
import {paths} from '@/lib/paths'
import {formatShortcut} from '@/lib/platform'
import {RenameMeetingSheet} from '../components/RenameMeetingSheet'
import {backfillActionItems} from '../lib/actionItemSync'
import {FolderBar} from './FolderBar'
import {DeleteFolderSheet, FolderNameSheet} from '../components/FolderSheets'
import {MeetingList} from './MeetingList'
import {needsPermissionBanner, useAudioAccess} from './audioAccess'
import {PermissionBanner} from './PermissionBanner'
import {readyOffer} from '../lib/updates'
import {UpdateBanner} from './UpdateBanner'

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

const NoMatch = styled(Muted)`
    padding: ${({theme}) => theme.space[6]} ${({theme}) => theme.space[4]};
    text-align: center;
`

const matches = (text: string | undefined, query: string) => !!text && text.toLowerCase().includes(query)

/**
 * Home: the meetings list. Search filters it by title and folder as the
 * user types (search in transcripts is #118's); the folder chips filter it
 * by folder, kept in the URL (`?folder=`), so Back from a meeting returns
 * to the same folder. Banners say when an update waits for a restart and
 * when Protocol cannot hear the microphone or the computer audio. The
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
    const shows = useCallback((meeting: MeetingListItem) =>
        (!folderId || meeting.group_id === folderId) &&
        (!needle || matches(meeting.title, needle) || matches(meeting.group_id ? names.get(meeting.group_id) : undefined, needle)),
    [folderId, needle, names])

    const offer = readyOffer(updater.data)
    const showPermission = needsPermissionBanner(access)
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
                        placeholder="Search meetings"
                        icon={<MagnifyingGlassIcon aria-hidden/>}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape' && query) {
                                event.preventDefault()
                                setQuery('')
                            }
                        }}
                    />
                </Search>
            )}
            <AnimatePresence initial={false}>
                {offer && updater.data && <UpdateBanner key="update" snapshot={updater.data} offer={offer}/>}
                {showPermission && access && <PermissionBanner key="permission" access={access}/>}
            </AnimatePresence>
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
                        folders={folderList}
                        onRename={(meeting) => setRenaming({open: true, meeting})}
                        empty={(
                            <NoMatch>
                                {needle ? `No meetings match “${query.trim()}”.` : 'No meetings in this folder yet.'}
                            </NoMatch>
                        )}
                    />
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
