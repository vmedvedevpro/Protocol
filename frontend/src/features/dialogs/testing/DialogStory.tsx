// Stories only (*.stories.tsx import it); the app never does, so no build carries it.
import {createElement, useEffect} from 'react'
import {StoryWindow} from '@/components/screen/StoryWindow'
import {type DialogRequest, openDialog, resetDialogs} from '@/lib/dialogs'
import {DialogHost} from '../DialogHost'

/**
 * A dialog's story: the dialogs as the shell mounts them, in a window of the
 * app's size, opened on `request`. The screen under it is a stand-in, since
 * the screens belong to other features.
 */
export function DialogStory({request}: { request: DialogRequest }) {
    useEffect(() => {
        openDialog(request)
        return resetDialogs
    }, [request])
    return (
        <StoryWindow
            url="/"
            routes={[{path: '*', element: createElement('div', null, createElement(DialogHost), createElement('h1', null, 'The screen under the dialog'))}]}
        />
    )
}
