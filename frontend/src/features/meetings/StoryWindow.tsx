import type {ReactElement} from 'react'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import styled from 'styled-components'

// The main window's content area: 460 px wide, below the title bar.
const Frame = styled.div`
    display: flex;
    flex-direction: column;
    width: 460px;
    height: 720px;
    overflow: hidden;
    border: 1px solid ${({theme}) => theme.colors.border};
    background: ${({theme}) => theme.colors.bg};
`

/**
 * A meetings screen in a window-sized frame, under a memory router at
 * `url`; links to other screens land on a stub. For stories.
 */
export function StoryWindow({url, path, element}: { url: string, path: string, element: ReactElement }) {
    const router = createMemoryRouter([
        {path, element: <Frame>{element}</Frame>},
        {path: '*', element: <Frame><p>Another screen</p></Frame>},
    ], {initialEntries: [url]})
    return <RouterProvider router={router}/>
}
