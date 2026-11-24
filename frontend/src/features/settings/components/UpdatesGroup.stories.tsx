import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {UpdaterSnapshot} from '@/api/updater'
import {mockState} from '@/mocks/state'
import {createMockUpdateRelease} from '@/mocks/updater'
import {StoryWindow} from '../stories/StoryWindow'
import {UpdatesGroup} from './UpdatesGroup'

const Pad = styled.div`
    padding: ${({theme}) => theme.space[4]};
    overflow-y: auto;
`

function Updates() {
    return <StoryWindow><Pad><UpdatesGroup/></Pad></StoryWindow>
}

const offer = (patch: Partial<NonNullable<UpdaterSnapshot['offer']>> = {}) => ({
    release: createMockUpdateRelease(),
    downloaded: false,
    manualOnly: false,
    waitingForRecording: false,
    ...patch,
})

const snapshot = (patch: Partial<UpdaterSnapshot>) => () => {
    mockState.updater = {...mockState.updater, lastCheckedAt: Date.now() - 5 * 60_000, ...patch}
}

const meta = {
    title: 'Settings/Updates',
    component: Updates,
} satisfies Meta<typeof Updates>

export default meta

type Story = StoryObj<typeof meta>

/** Not checked yet: Check now finds 0.7.0, Download moves, Restart and update installs. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

export const Available: Story = {globals: {theme: 'light'}, beforeEach: snapshot({offer: offer()})}

export const Downloading: Story = {
    globals: {theme: 'light'},
    beforeEach: snapshot({offer: offer(), activity: {state: 'downloading', received: 21 * 1024 * 1024, total: 48 * 1024 * 1024}}),
}

export const ReadyToInstall: Story = {globals: {theme: 'light'}, beforeEach: snapshot({offer: offer({downloaded: true})})}

export const ReadyToInstallDark: Story = {globals: {theme: 'dark'}, beforeEach: snapshot({offer: offer({downloaded: true})})}

/** A summary runs: Restart and update waits and says why. */
export const WaitingForWork: Story = {
    globals: {theme: 'light'},
    beforeEach: snapshot({offer: offer({downloaded: true}), busyReasons: ['summary']}),
}

/** Installed with apt: the package comes from GitHub. */
export const ManualOnly: Story = {
    globals: {theme: 'light'},
    beforeEach: snapshot({support: {kind: 'manualOnly', install: 'deb'}, offer: offer({manualOnly: true})}),
}

export const UpToDate: Story = {globals: {theme: 'light'}, beforeEach: snapshot({})}

export const CheckFailed: Story = {
    globals: {theme: 'light'},
    beforeEach: snapshot({error: {kind: 'network', action: 'check', message: 'offline', at: Date.now(), background: false}}),
}

export const DownloadFailed: Story = {
    globals: {theme: 'light'},
    beforeEach: snapshot({
        offer: offer(),
        error: {kind: 'download', action: 'download', message: 'connection reset', at: Date.now(), background: false},
    }),
}

export const DevelopmentBuild: Story = {globals: {theme: 'light'}, beforeEach: snapshot({support: {kind: 'off', reason: 'dev'}})}
