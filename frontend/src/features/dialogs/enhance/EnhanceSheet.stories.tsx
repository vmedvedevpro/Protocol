import type {Meta, StoryObj} from '@storybook/react-vite'
import {mockState} from '@/mocks/state'
import {DialogStory} from '../testing/DialogStory'

const meta = {
    title: 'Dialogs/Improve the transcript',
    component: DialogStory,
    args: {request: {kind: 'enhance', meetingId: 'meeting-acme-review'}},
} satisfies Meta<typeof DialogStory>

export default meta

type Story = StoryObj<typeof meta>

/** Parakeet, the after-meeting model: the language is its own. Start runs the mock pass. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Words already kept for this meeting, which Clear removes. */
export const KeptWords: Story = {
    beforeEach: () => {
        mockState.speech.vocabulary.meetings['meeting-acme-review'] = 'Acme\nTom Becker\nSOC 2'
    },
}
