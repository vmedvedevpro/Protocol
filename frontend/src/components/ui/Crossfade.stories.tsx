import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {Button} from './Button'
import {Crossfade, CrossfadeView} from './Crossfade'
import {Sheet} from './Sheet'

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

// A sheet over the views, as Summary options over a meeting's tab panel:
// the whole sheet shows above them. A view's z-index once reached the page's
// root stacking context and painted over the sheet's lower part (#121).
function SheetOverViews() {
    const [open, setOpen] = useState(true)
    return (
        <>
            <Views/>
            <Button size="sm" onClick={() => setOpen(true)}>Open the sheet</Button>
            <Sheet open={open} onOpenChange={setOpen} title="A sheet over the views">
                <Card>
                    <p>Every line of the sheet is drawn above the views.</p>
                    <p>The last line too.</p>
                </Card>
            </Sheet>
        </>
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

export const UnderASheet: Story = {globals: {theme: 'light'}, render: () => <SheetOverViews/>}
