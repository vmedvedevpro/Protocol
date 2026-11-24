import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {Platform} from '@/lib/platform'
import {mockState} from '@/mocks/state'
import {PermissionBanner} from './PermissionBanner'

const Column = styled.div`
    width: 460px;
`

function PermissionBannerDemo({on, microphone, computerAudio}: { on: Platform, microphone: boolean, computerAudio: boolean }) {
    return <Column><PermissionBanner on={on} access={{microphone, computerAudio}}/></Column>
}

const meta = {
    title: 'Meetings/PermissionBanner',
    component: PermissionBannerDemo,
    args: {on: 'macos', microphone: true, computerAudio: false},
    argTypes: {on: {control: 'inline-radio', options: ['macos', 'windows']}},
    // What macOS's Audio Capture record says decides the advice.
    beforeEach: () => {
        mockState.platform = 'macos'
        mockState.permissions.systemAudio = 'denied'
    },
} satisfies Meta<typeof PermissionBannerDemo>

export default meta

type Story = StoryObj<typeof meta>

/** macOS without Audio Capture: its pane, and Check again. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Neither source: both panes, the microphone's first. */
export const NothingHeard: Story = {args: {microphone: false}}

/** Windows has no privacy pane to open: Check again alone. */
export const Windows: Story = {args: {on: 'windows', microphone: false, computerAudio: true}}
