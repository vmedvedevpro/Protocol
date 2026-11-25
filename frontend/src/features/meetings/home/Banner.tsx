import type {ReactNode} from 'react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {Veil} from '@/components/ui/Veil'
import {tween} from '@/styles/motion'

const Card = styled(m.div)`
    position: relative;
    display: flex;
    flex: none;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2.5]};
    margin: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    background: ${({theme}) => theme.colors.raised};

    > svg {
        flex: none;
        margin-top: ${({theme}) => theme.space[0.5]};
        color: ${({theme}) => theme.colors.muted};
    }
`

const Body = styled.div`
    flex: 1;
    min-width: 0;
`

const Title = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Description = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Actions = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: ${({theme}) => theme.space[1.5]};
    margin-top: ${({theme}) => theme.space[2]};
`

interface BannerProps {
    icon: ReactNode
    title: string
    description: ReactNode
    /** Buttons: the main one filled, the others secondary. */
    actions: ReactNode
}

/**
 * Something on Home that needs the user: an update waiting for a restart,
 * an audio permission missing. It arrives with a 4 px rise under a veil
 * inside a Collapse, which opens its slot so what is below slides, and
 * goes under the veil as the slot closes; its title and description are a
 * status, read once when it appears.
 */
export function Banner({icon, title, description, actions}: BannerProps) {
    return (
        <Card
            role="status"
            initial={{y: -4}}
            animate={{y: 0}}
            transition={tween('base', 'enter')}
        >
            {icon}
            <Body>
                <Title>{title}</Title>
                <Description>{description}</Description>
                <Actions>{actions}</Actions>
            </Body>
            {/* Over the border too: the whole card arrives. */}
            <Veil outset={1}/>
        </Card>
    )
}
