import {useEffect} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {useModelDownloadSync} from '@/api/modelDownloadSync'
import {downloadWhisperModel} from '@/api/models'
import {mockState} from '@/mocks/state'
import {DownloadLineContext} from './downloadLineContext'
import {Screen} from './Screen'
import {StoryWindow} from './StoryWindow'

/** A screen while Whisper Small downloads in the mock, slowly. */
function Downloading() {
    useModelDownloadSync()
    useEffect(() => {
        mockState.models.downloadStep = 1
        void downloadWhisperModel('small').catch(() => undefined)
    }, [])
    return (
        <DownloadLineContext value>
            <StoryWindow
                url="/"
                routes={[
                    {path: '/', element: <Screen><h1 style={{padding: 16}}>Meetings</h1></Screen>},
                    {path: '/settings/:page', element: <h1 style={{padding: 16}}>Speech models</h1>},
                ]}
            />
        </DownloadLineContext>
    )
}

const meta = {
    title: 'Screen/DownloadLine',
    component: Downloading,
} satisfies Meta<typeof Downloading>

export default meta

type Story = StoryObj<typeof meta>

/** The footer's line on every screen: what downloads and how far; a click opens Speech models. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
