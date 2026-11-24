import {useState} from 'react'
import {createMemoryRouter, type RouteObject, RouterProvider} from 'react-router-dom'
import styled from 'styled-components'

// The main window opens at 460×700, so a story lays out as the app does.
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
    /** The feature's routes; a link elsewhere needs a stand-in route. */
    routes: RouteObject[]
    /** Where the window opens. */
    url: string
}

/**
 * A screen's story in a window of the app's size, under a memory router.
 * The router is made once, from the first render's props, so a story's
 * navigation survives its re-renders.
 */
export function StoryWindow({routes, url}: StoryWindowProps) {
    const [router] = useState(() => createMemoryRouter(routes, {initialEntries: [url]}))
    return <Frame><RouterProvider router={router}/></Frame>
}
