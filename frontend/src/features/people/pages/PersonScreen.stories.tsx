import {createElement} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {StoryWindow} from '@/components/screen/StoryWindow'
import {mockState} from '@/mocks/state'
import {PersonRoute} from './PersonScreen'

function PersonDemo({url}: { url: string }) {
    return (
        <StoryWindow
            url={url}
            routes={[
                {path: '/person/:personId', element: createElement(PersonRoute)},
                {path: '*', element: createElement('h1', null, 'Another screen')},
            ]}
        />
    )
}

const meta = {
    title: 'People/PersonScreen',
    component: PersonDemo,
    args: {url: '/person/person-priya'},
} satisfies Meta<typeof PersonDemo>

export default meta

type Story = StoryObj<typeof meta>

/** Details, the meetings together and private notes; More holds Edit, Merge and Delete. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Labs › Voice profiles on: the voice can be learned from their meetings. */
export const VoiceLab: Story = {
    beforeEach: () => {
        mockState.labs.voiceProfiles = true
    },
}

/** A voice learned before Labs was turned off: it can only be forgotten. */
export const LearnedVoice: Story = {args: {url: '/person/person-tom'}}

export const Missing: Story = {args: {url: '/person/person-gone'}}
