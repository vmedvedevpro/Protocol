import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {Select} from './Select'

const Row = styled.div`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[4]};
    height: 220px;
`

const MODELS = [
    {value: 'parakeet', label: 'Parakeet'},
    {value: 'turbo', label: 'Whisper Large V3 Turbo'},
    {value: 'medium', label: 'Whisper Medium'},
] as const

const LANGUAGES = [
    {value: 'auto', label: 'Detect automatically'},
    {value: 'en', label: 'English'},
    {value: 'de', label: 'German'},
    {value: 'ru', label: 'Russian'},
] as const

// The selects of the settings rows and sheets: a long value cut with an
// ellipsis, a short list, one with nothing chosen yet, and one waiting for
// its options (its spinner shows after the spinner's delay).
function Selects() {
    const [model, setModel] = useState<(typeof MODELS)[number]['value']>('turbo')
    const [language, setLanguage] = useState<(typeof LANGUAGES)[number]['value'] | undefined>(undefined)
    return (
        <Row>
            <Select label="Model" options={MODELS} value={model} onValueChange={setModel}/>
            <Select label="Language" placeholder="Choose a language" options={LANGUAGES} value={language} onValueChange={setLanguage}/>
            <Select label="Unavailable" options={MODELS} value="parakeet" onValueChange={() => {}} disabled/>
            <Select label="Loading" placeholder="Loading models…" options={[]} value={undefined} onValueChange={() => {}} disabled pending/>
        </Row>
    )
}

const meta = {
    title: 'UI/Select',
    component: Selects,
} satisfies Meta<typeof Selects>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
