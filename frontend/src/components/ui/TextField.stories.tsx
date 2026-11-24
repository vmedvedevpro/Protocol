import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {formatShortcut} from '@/lib/platform'
import {Kbd} from './Kbd'
import {TextArea, TextField} from './TextField'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[5]};
    width: 388px;
`

// The first launch's name, the meetings search, a sheet's search and the
// summary's "Write it again".
function Fields() {
    const [name, setName] = useState('')
    const [query, setQuery] = useState('')
    const [instruction, setInstruction] = useState('')
    return (
        <Column>
            <TextField
                size="lg"
                label="What should we call you?"
                hint="Shown instead of “You” in transcripts. You can change it in Settings."
                placeholder="Your name"
                value={name}
                onChange={(event) => setName(event.target.value)}
            />
            <TextField
                type="search"
                tone="soft"
                aria-label="Search meetings"
                placeholder="Search meetings and transcripts"
                icon={<MagnifyingGlassIcon size={15}/>}
                trailing={<Kbd tone="raised">{formatShortcut('K')}</Kbd>}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
            />
            <TextField type="search" aria-label="Search contacts or type a name" placeholder="Search contacts or type a name"/>
            <TextArea
                label="Write it again"
                placeholder="Anything to focus on? For example: only the decisions about the pilot"
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
            />
            <TextArea aria-label="Words to recognize" mono defaultValue={'Acme\nPriya Shah\nParakeet'}/>
            <TextField size="sm" aria-label="Unavailable" defaultValue="Read only" disabled/>
        </Column>
    )
}

const meta = {
    title: 'UI/TextField',
    component: Fields,
} satisfies Meta<typeof Fields>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
