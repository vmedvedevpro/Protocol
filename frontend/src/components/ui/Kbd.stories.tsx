import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {formatShortcut} from '@/lib/platform'
import {Button} from './Button'
import {Kbd} from './Kbd'

const Row = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

const Field = styled.span`
    display: inline-flex;
    padding: ${({theme}) => theme.space[1.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};
`

// On the window, on a grey search field, and on the filled Record button.
function Keys() {
    return (
        <Row>
            <Kbd>esc</Kbd>
            <Kbd>{formatShortcut('K')}</Kbd>
            <Field><Kbd tone="raised">{formatShortcut('K')}</Kbd></Field>
            <Button variant="filled" trailing={<Kbd tone="fill">{formatShortcut('R')}</Kbd>}>Record</Button>
        </Row>
    )
}

const meta = {
    title: 'UI/Kbd',
    component: Keys,
} satisfies Meta<typeof Keys>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
