import {useState} from 'react'
import {ArrowUUpLeftIcon, FolderPlusIcon, MicrophoneIcon, PauseIcon, PlayIcon, StopIcon, UserPlusIcon} from '@phosphor-icons/react'
import {useLocation, useNavigate} from 'react-router-dom'
import {useRecordingPhase} from '@/api/recordingPhase'
import {FolderNameSheet} from '@/features/meetings/components/FolderSheets'
import {ContactSheet} from '@/features/people/components/ContactSheets'
import {togglePause, toggleRecording} from '@/features/recording/store/runtime'
import {type SearchCommand, SearchDialog} from '@/features/search/components/SearchDialog'
import {paths} from '@/lib/paths'
import {formatShortcut} from '@/lib/platform'

/**
 * Search (⌘K) with the commands that belong to other features: the
 * recording's (start, pause or resume, stop, back to it), a new folder and a
 * new contact, whose sheets open here once search has closed. Import a
 * recording joins them with #119's import sheet.
 */
export function GlobalSearch() {
    const navigate = useNavigate()
    const {pathname} = useLocation()
    const phase = useRecordingPhase()
    const [sheet, setSheet] = useState<'folder' | 'contact' | null>(null)
    const sheetOpen = (name: typeof sheet) => ({
        open: sheet === name,
        onOpenChange: (open: boolean) => setSheet(open ? name : null),
    })

    const actions: SearchCommand[] = []
    const live = phase === 'recording' || phase === 'paused'
    if (phase === 'idle') {
        actions.push({id: 'record', label: 'Start recording', keywords: 'record new meeting call', icon: <MicrophoneIcon/>, shortcut: formatShortcut('R'), run: toggleRecording})
    }
    if (phase !== 'idle' && pathname !== paths.recording) {
        actions.push({id: 'back', label: 'Back to the recording', keywords: 'live transcript notes', icon: <ArrowUUpLeftIcon/>, run: () => void navigate(paths.recording)})
    }
    if (live) {
        actions.push(
            phase === 'paused'
                ? {id: 'resume', label: 'Resume recording', keywords: 'continue', icon: <PlayIcon/>, run: () => void togglePause()}
                : {id: 'pause', label: 'Pause recording', keywords: 'hold', icon: <PauseIcon/>, run: () => void togglePause()},
            {id: 'stop', label: 'Stop recording', keywords: 'end finish save', icon: <StopIcon/>, shortcut: formatShortcut('R'), run: toggleRecording},
        )
    }
    actions.push(
        {id: 'new-folder', label: 'New folder', keywords: 'create group customer team project', icon: <FolderPlusIcon/>, run: () => setSheet('folder')},
        {id: 'new-contact', label: 'New contact', keywords: 'create person people add', icon: <UserPlusIcon/>, run: () => setSheet('contact')},
    )

    return (
        <>
            <SearchDialog actions={actions}/>
            <FolderNameSheet {...sheetOpen('folder')} onCreated={(folder) => void navigate(paths.folder(folder.id))}/>
            <ContactSheet {...sheetOpen('contact')} onSaved={(person) => void navigate(paths.person(person.id))}/>
        </>
    )
}
