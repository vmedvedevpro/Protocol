import type {Meta, StoryObj} from '@storybook/react-vite'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import styled from 'styled-components'
import {RouteError} from './RouteError'

const Window = styled.div`
    display: flex;
    flex-direction: column;
    width: 100vw;
    height: 100vh;
`

function Broken(): never {
    throw new TypeError('Cannot read properties of undefined (reading \'segments\')')
}

/** The error screen as React Router shows it for a screen that threw. */
function BrokenScreen() {
    const router = createMemoryRouter([{path: '/', element: <Broken/>, errorElement: <RouteError/>}])
    return <Window><RouterProvider router={router}/></Window>
}

const meta = {
    title: 'Shell/RouteError',
    component: BrokenScreen,
    parameters: {layout: 'fullscreen'},
} satisfies Meta<typeof BrokenScreen>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
