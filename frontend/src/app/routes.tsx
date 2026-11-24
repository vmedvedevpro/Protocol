import {Navigate, type RouteObject} from 'react-router-dom'
import {HomeScreen} from '@/features/meetings/home/HomeScreen'
import {RecordingPage} from '@/features/recording/pages/RecordingPage'
import {SettingsPage} from '@/features/settings/pages/SettingsPage'
import {SettingsSubpage} from '@/features/settings/pages/SettingsSubpage'
import {MeetingPlaceholder} from './placeholder/Screens'
import {MinibarPlaceholder} from './placeholder/MinibarPlaceholder'
import {Shell, type ShellRouteHandle} from './shell/Shell'

const back: ShellRouteHandle = {back: true}

/**
 * The route table of both windows (paths.ts names the paths). The main
 * window's screens live under the shell; the minibar is its own window
 * without it. A screen's task replaces its placeholder here.
 */
export const routes: RouteObject[] = [
    {
        element: <Shell/>,
        children: [
            {index: true, element: <HomeScreen/>},
            {path: 'meetings/:meetingId', element: <MeetingPlaceholder/>, handle: back},
            {path: 'recording', element: <RecordingPage/>, handle: back},
            {path: 'settings', element: <SettingsPage/>, handle: {...back, title: 'Settings'} satisfies ShellRouteHandle},
            {path: 'settings/:page', element: <SettingsSubpage/>, handle: {...back, title: 'Settings'} satisfies ShellRouteHandle},
        ],
    },
    // minibar.rs opens this route in its own window.
    {path: '/minibar', element: <MinibarPlaceholder/>},
    // Anything else, such as an old UI's path, goes home.
    {path: '*', element: <Navigate to="/" replace/>},
]
