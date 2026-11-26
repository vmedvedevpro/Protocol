import {useState} from 'react'
import {createMemoryRouter, type RouteObject, RouterProvider} from 'react-router-dom'
import styled from 'styled-components'

// The main window opens at 460×700, so a story lays out as the app does;
// a story of a narrower window (the minimum, 360 px) passes its width.
const Frame = styled.div<{ $width: string }>`
    display: flex;
    flex-direction: column;
    width: ${({$width}) => $width};
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
    /** The window's width, `460px` as it opens. */
    width?: string
}

/**
 * A screen's story in a window of the app's size, under a memory router.
 * The router is made once, from the first render's props, so a story's
 * navigation survives its re-renders.
 */
export function StoryWindow({routes, url, width = '460px'}: StoryWindowProps) {
    const [router] = useState(() => createMemoryRouter(routes, {initialEntries: [url]}))
    return <Frame $width={width}><RouterProvider router={router}/></Frame>
}
