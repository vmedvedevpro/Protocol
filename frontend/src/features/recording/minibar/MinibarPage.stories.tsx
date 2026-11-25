import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {reset, startLiveRecording} from '../test/stories'
import {MinibarPage} from './MinibarPage'

const Window = styled.div`
    width: ${({theme}) => theme.sizes.minibar.width};
    height: ${({theme}) => theme.sizes.minibar.height};
`

// The page on the mock recorder, 12 minutes in: the timer runs, the ring
// and the meters follow the fake conversation, and every button calls the
// mock's native commands (Stop ends the mock recording).
function LiveMinibar() {
    return (
        <Window>
            <MinibarPage/>
        </Window>
    )
}

const meta = {
    title: 'Recording/MinibarPage',
    component: LiveMinibar,
    beforeEach: async () => {
        await reset()
        await startLiveRecording()
    },
} satisfies Meta<typeof LiveMinibar>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
