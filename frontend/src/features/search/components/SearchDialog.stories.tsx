import {createElement} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {FolderPlusIcon, MicrophoneIcon} from '@phosphor-icons/react'
import {StoryWindow} from '@/components/screen/StoryWindow'
import {openSearch} from '@/lib/searchLauncher'
import {type SearchCommand, SearchDialog} from './SearchDialog'

// What app/shell/GlobalSearch passes in; here they do nothing.
const actions: SearchCommand[] = [
    {id: 'record', label: 'Start recording', icon: createElement(MicrophoneIcon), shortcut: '⌘R', run: () => {}},
    {id: 'new-folder', label: 'New folder', icon: createElement(FolderPlusIcon), run: () => {}},
]

function SearchDemo() {
    return <StoryWindow url="/" routes={[{path: '*', element: <SearchDialog actions={actions}/>}]}/>
}

const meta = {
    title: 'Search/SearchDialog',
    component: SearchDemo,
    beforeEach: () => openSearch(),
} satisfies Meta<typeof SearchDemo>

export default meta

type Story = StoryObj<typeof meta>

/** No query yet: the commands and the recent meetings. ⌘K opens it again after Escape. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Words found in lines, summaries and action items, grouped as native ranks them. */
export const Results: Story = {beforeEach: () => openSearch('retention')}

/** A person and the meetings with their name. */
export const People: Story = {beforeEach: () => openSearch('Priya')}

export const NothingFound: Story = {beforeEach: () => openSearch('zxqv')}
