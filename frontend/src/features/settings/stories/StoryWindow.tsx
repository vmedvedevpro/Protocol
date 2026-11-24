import {type ReactNode, useState} from 'react'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import styled from 'styled-components'
import {useUpdaterStatusSync} from '@/app/useUpdaterStatusSync'
import {SettingsSubpage} from '../pages/SettingsSubpage'

// The main window's size, so a story lays out as the app does.
const Frame = styled.div`
    display: flex;
    flex-direction: column;
    width: 460px;
    height: 700px;
    overflow: hidden;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.bg};
    color: ${({theme}) => theme.colors.text};
`

interface StoryWindowProps {
    /** Where the window opens, `/settings?section=recording` for one. */
    path?: string
    /** What `/settings` shows: the Settings page, or a part of it. */
    children: ReactNode
}

/**
 * A Settings story in a window of the app's size, with the router and what
 * App mounts for Settings: the updater snapshot kept current from its event.
 */
export function StoryWindow({path = '/settings', children}: StoryWindowProps) {
    useUpdaterStatusSync()
    const [router] = useState(() => createMemoryRouter(
        [
            {path: '/', element: <h1>Meetings</h1>},
            {path: '/settings', element: children},
            {path: '/settings/:page', element: <SettingsSubpage/>},
        ],
        {initialEntries: [path]},
    ))
    return <Frame><RouterProvider router={router}/></Frame>
}
