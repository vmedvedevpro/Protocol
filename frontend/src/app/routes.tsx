import {Navigate, type RouteObject} from 'react-router-dom'
import {HomeScreen} from '@/features/meetings/home/HomeScreen'
import {MeetingRoute} from '@/features/meetings/meeting/MeetingScreen'
import {MinibarPage} from '@/features/recording/minibar/MinibarPage'
import {RecordingPage} from '@/features/recording/pages/RecordingPage'
import {SettingsPage} from '@/features/settings/pages/SettingsPage'
import {SettingsSubpage} from '@/features/settings/pages/SettingsSubpage'
import {Shell, type ShellRouteHandle} from './shell/Shell'

const back: ShellRouteHandle = {back: true}

/**
 * The route table of both windows (paths.ts names the paths). The main
 * window's screens live under the shell; the minibar is its own window
 * without it.
 */
export const routes: RouteObject[] = [
    {
        element: <Shell/>,
        children: [
            {index: true, element: <HomeScreen/>},
            {path: 'meetings/:meetingId', element: <MeetingRoute/>, handle: back},
            {path: 'recording', element: <RecordingPage/>, handle: back},
            {path: 'settings', element: <SettingsPage/>, handle: {...back, title: 'Settings'} satisfies ShellRouteHandle},
            {path: 'settings/:page', element: <SettingsSubpage/>, handle: {...back, title: 'Settings'} satisfies ShellRouteHandle},
        ],
    },
    // minibar.rs opens this route in its own window.
    {path: '/minibar', element: <MinibarPage/>},
    // Anything else, such as an old UI's path, goes home.
    {path: '*', element: <Navigate to="/" replace/>},
]
