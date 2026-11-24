import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {Button} from './Button'
import {Crossfade, CrossfadeView} from './Crossfade'

const Column = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
    width: 320px;
    height: 220px;
`

const Card = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[3]};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.soft};
`

// Two views of different heights in one place, as Settings' simple page and
// its sections: the old one fades out as the new one fades in, and its
// button is out of reach while it fades.
function Views() {
    const [more, setMore] = useState(false)
    return (
        <Column>
            <Button size="sm" variant="ghost" onClick={() => setMore(!more)}>
                {more ? 'Fewer settings' : 'More settings'}
            </Button>
            <Crossfade>
                {more ? (
                    <CrossfadeView key="more">
                        <Card>
                            <p>Every section, in tabs.</p>
                            <p>General, Recording, AI and Advanced.</p>
                            <Button size="sm">A control in the new view</Button>
                        </Card>
                    </CrossfadeView>
                ) : (
                    <CrossfadeView key="fewer">
                        <Card>
                            <p>What most people need.</p>
                            <Button size="sm">A control in the old view</Button>
                        </Card>
                    </CrossfadeView>
                )}
            </Crossfade>
        </Column>
    )
}

const meta = {
    title: 'UI/Crossfade',
    component: Views,
} satisfies Meta<typeof Views>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
