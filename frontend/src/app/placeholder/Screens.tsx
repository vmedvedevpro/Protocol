import type {ReactNode} from 'react'
import {GearIcon} from '@phosphor-icons/react'
import {useNavigate, useParams, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {Button, IconButton} from '@/components/ui/Button'
import {formatShortcut} from '@/lib/platform'
import {paths} from '@/lib/paths'
import {Screen} from '@/components/screen/Screen'
import {ThemeSwitch} from './ThemeSwitch'

// Stand-ins for the screens until their tasks replace them in the route
// table (routes.tsx): each has its h1 and the controls that exercise the
// shell, nothing of the screen itself.

const Head = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[4]};
`

const Title = styled.h1`
    flex: 1;
    min-width: 0;
    ${({theme}) => theme.text.screen};
`

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[3]};
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

const Note = styled.p`
    color: ${({theme}) => theme.colors.muted};
`

function Placeholder({title, actions, recordBar, children}: {
    title: string
    actions?: ReactNode
    recordBar?: boolean
    children: ReactNode
}) {
    return (
        <Screen recordBar={recordBar}>
            <Head>
                <Title>{title}</Title>
                {actions}
            </Head>
            <Body>{children}</Body>
        </Screen>
    )
}

export function HomePlaceholder() {
    const navigate = useNavigate()

    return (
        <Placeholder
            title="Meetings"
            actions={(
                <IconButton label="Settings" shortcut={formatShortcut(',')} onClick={() => void navigate(paths.settings())}>
                    <GearIcon size={17}/>
                </IconButton>
            )}
            recordBar
        >
            <Note>The meetings list arrives with #113.</Note>
            <Button size="sm" onClick={() => void navigate(paths.meeting('sample'))}>Open a sample meeting</Button>
        </Placeholder>
    )
}

export function MeetingPlaceholder() {
    const {meetingId} = useParams()
    return (
        <Placeholder title="Meeting">
            <Note>Meeting “{meetingId}”. The meeting screen arrives with #113.</Note>
        </Placeholder>
    )
}

export function RecordingPlaceholder() {
    return (
        <Placeholder title="Recording">
            <Note>The recording screen arrives with #112.</Note>
        </Placeholder>
    )
}

export function SettingsPlaceholder() {
    const [search] = useSearchParams()
    const section = search.get('section')
    return (
        <Placeholder title="Settings">
            {section && <Note>Opened at the old section “{section}”.</Note>}
            <ThemeSwitch/>
            <Note>Settings arrive with #114 and #117.</Note>
        </Placeholder>
    )
}

export function FirstLaunchPlaceholder() {
    return (
        <Placeholder title="Welcome to Protocol">
            <Note>First launch arrives with #115.</Note>
        </Placeholder>
    )
}
