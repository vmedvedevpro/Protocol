import {type ReactNode, useId, useMemo} from 'react'
import {ArrowSquareOutIcon, CaretRightIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {ControlLabelContext} from './controlLabelling'
import {colorTransition} from './styles'

const Section = styled.section`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};
`

const GroupTitle = styled.h2`
    padding: 0 ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

// Rows sit on one grey card, divided by hairlines.
const Card = styled.div`
    overflow: hidden;
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};

    > * + * {
        border-top: 1px solid ${({theme}) => theme.colors.border};
    }
`

const Note = styled.p`
    padding: 0 ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

interface SettingsGroupProps {
    /** A small heading over the card; also names the group. */
    title?: string
    /** A line under the card. */
    note?: string
    children: ReactNode
}

/** Settings rows on one card, with an optional heading above and a note below. */
export function SettingsGroup({title, note, children}: SettingsGroupProps) {
    const titleId = useId()
    return (
        <Section aria-labelledby={title ? titleId : undefined}>
            {title && <GroupTitle id={titleId}>{title}</GroupTitle>}
            <Card>{children}</Card>
            {note && <Note>{note}</Note>}
        </Section>
    )
}

const Row = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
`

const Line = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

const Text = styled.span`
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    text-align: left;
`

const Label = styled.span`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.text};
`

const Description = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Badge = styled.span`
    padding: 0 ${({theme}) => theme.space[1]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.xs};
    ${({theme}) => theme.text.caption};
    color: ${({theme}) => theme.colors.muted};
`

interface SettingsRowProps {
    label: string
    description?: string
    /** A short tag after the label, such as "Labs". */
    badge?: string
    /**
     * The control on the right: a Switch, a Select, a small TextField or
     * Buttons. A Switch, Select or field without a label of its own is named
     * by the row's label and described by its description.
     */
    control?: ReactNode
    /** Content under the label that takes the row's width: a slider, a text area, a progress bar. */
    children?: ReactNode
}

/** One setting: its label and description, its control on the right, and anything wide below. */
export function SettingsRow({label, description, badge, control, children}: SettingsRowProps) {
    const labelId = useId()
    const descriptionId = useId()
    const ids = useMemo(
        () => ({labelId, descriptionId: description ? descriptionId : undefined}),
        [labelId, descriptionId, description],
    )

    return (
        <ControlLabelContext.Provider value={ids}>
            <Row>
                <Line>
                    <Text>
                        <Label>
                            <span id={labelId}>{label}</span>
                            {badge && <Badge>{badge}</Badge>}
                        </Label>
                        {description && <Description id={descriptionId}>{description}</Description>}
                    </Text>
                    {control}
                </Line>
                {children}
            </Row>
        </ControlLabelContext.Provider>
    )
}

const NavButton = styled.button`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
    width: 100%;
    margin: 0;
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[3]};
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    cursor: pointer;
    ${colorTransition};

    &:hover {
        background: ${({theme}) => theme.colors.raised};
    }

    /* Inside the card's rounded clip an outset outline would be cut off. */
    &:focus-visible {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: -2px;
    }

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }
`

const Value = styled.span`
    max-width: ${({theme}) => theme.sizes.popover.triggerMaxWidth};
    overflow: hidden;
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.regular};
    color: ${({theme}) => theme.colors.muted};
    text-overflow: ellipsis;
    white-space: nowrap;
`

interface SettingsNavRowProps {
    label: string
    description?: string
    /** The current value, shown before the arrow. */
    value?: string
    /** Opens something outside the app (a web page) instead of a subpage. */
    external?: boolean
    onClick: () => void
}

/** A row that opens a subpage, or a page outside the app, showing the current value. */
export function SettingsNavRow({label, description, value, external = false, onClick}: SettingsNavRowProps) {
    return (
        <NavButton type="button" onClick={onClick}>
            <Text>
                <Label>{label}</Label>
                {description && <Description>{description}</Description>}
            </Text>
            {value && <Value>{value}</Value>}
            {external ? <ArrowSquareOutIcon size={12} aria-hidden/> : <CaretRightIcon size={11} aria-hidden/>}
        </NavButton>
    )
}
