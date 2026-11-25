import {useState} from 'react'
import {DownloadSimpleIcon} from '@phosphor-icons/react'
import {getCurrentWindow} from '@tauri-apps/api/window'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {AUDIO_FORMATS_TEXT, isAudioPath} from '@/api/audioImport'
import {type NativeEvent, useNativeEvent} from '@/api/events'
import {toast} from '@/components/ui/toastStore'
import {openDialog} from '@/lib/dialogs'
import {platform} from '@/lib/platform'
import {tween} from '@/styles/motion'

// What Tauri sends while files are dragged over a webview (DragDropEvent).
const DRAG_ENTER_EVENT = 'tauri://drag-enter' as NativeEvent<{ paths: string[] }>
const DRAG_LEAVE_EVENT = 'tauri://drag-leave' as NativeEvent<null>
const DRAG_DROP_EVENT = 'tauri://drag-drop' as NativeEvent<{ paths: string[] }>

// Under the title strip, like a sheet's scrim; it takes no pointer, since
// the files are over the window and the webview gets no DOM drag events.
const Scrim = styled(m.div)`
    position: fixed;
    inset: ${({theme}) => theme.sizes.titleBar[platform]} 0 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: ${({theme}) => theme.space[6]};
    background: ${({theme}) => theme.colors.scrim};
    pointer-events: none;
`

const Card = styled(m.div)`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    max-width: 100%;
    padding: ${({theme}) => theme.space[6]} ${({theme}) => theme.space[8]};
    border: ${({theme}) => theme.sizes.radio.ring} dashed ${({theme}) => theme.colors.muted};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.dialog};
    text-align: center;

    > svg {
        color: ${({theme}) => theme.colors.muted};
    }
`

const Title = styled.p`
    margin: 0;
    ${({theme}) => theme.text.heading};
    color: ${({theme}) => theme.colors.text};
`

const Formats = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

/**
 * Files dragged anywhere over the main window: the window dims and says a
 * drop imports the recording. The first audio or video file dropped opens
 * Import with it; a drop with none says which formats work. Mounted with the
 * dialogs, so it hears nothing before first launch is done.
 */
export function DropOverlay() {
    const theme = useTheme()
    const [dragging, setDragging] = useState(false)
    // The main window's own drags; a drop on the minibar is not an import.
    const target = getCurrentWindow().label

    useNativeEvent(DRAG_ENTER_EVENT, () => setDragging(true), {target})
    useNativeEvent(DRAG_LEAVE_EVENT, () => setDragging(false), {target})
    useNativeEvent(DRAG_DROP_EVENT, ({paths}) => {
        setDragging(false)
        const audio = paths.find(isAudioPath)
        if (audio) openDialog({kind: 'import', path: audio})
        else if (paths.length > 0) toast.error('Please drop an audio file', {description: `Supported formats: ${AUDIO_FORMATS_TEXT}`})
    }, {target})

    return (
        <AnimatePresence>
            {dragging && (
                <Scrim
                    aria-hidden
                    initial={{opacity: 0}}
                    animate={{opacity: 1}}
                    exit={{opacity: 0, transition: tween('base', 'exit')}}
                    transition={tween('base')}
                >
                    <Card initial={{y: theme.space[1]}} animate={{y: 0}} transition={tween('base', 'enter')}>
                        <DownloadSimpleIcon size={24} aria-hidden/>
                        <Title>Drop to import this recording</Title>
                        <Formats>{AUDIO_FORMATS_TEXT}</Formats>
                    </Card>
                </Scrim>
            )}
        </AnimatePresence>
    )
}
