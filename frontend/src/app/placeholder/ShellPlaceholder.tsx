import {useQuery} from '@tanstack/react-query'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {appVersionQuery} from '@/api/app'
import {type UpdateError, type UpdaterSnapshot, updaterStatusQuery} from '@/api/updater'
import {Kbd} from '@/components/ui/Kbd'
import {type Status, StatusLine} from '@/components/ui/StatusLine'
import {formatShortcut, platform, type Platform} from '@/lib/platform'
import {ThemeSwitch} from './ThemeSwitch'

// A stand-in until the window shell and the screens arrive: one 460×700
// window showing the theme, the fonts and an icon on mock or native IPC. The
// whole palette and type scale are in Storybook, Foundations/Tokens.

const PLATFORM_NAMES: Record<Platform, string> = {macos: 'macOS', windows: 'Windows', linux: 'Linux'}

const FAILED: Record<UpdateError['action'], string> = {
    check: "Couldn't check for updates",
    download: "Couldn't download the update",
    install: "Couldn't start the update",
}

// The footer's update line, in the order of Settings › About on main: what
// the updater is doing, then a failure the user saw happen, then the offer,
// then the last check. A download keeps one key while its percent climbs
// beside the text, so the line swaps only when the meaning changes.
function describeUpdates(snapshot: UpdaterSnapshot | undefined, unavailable: boolean): Status {
    if (!snapshot) {
        return unavailable
            ? {key: 'unavailable', text: 'Update status unavailable'}
            : {key: 'reading', text: 'Reading update status…'}
    }
    const {support, activity, error, offer} = snapshot
    if (support.kind === 'off') {
        return {
            key: 'off',
            text: support.reason === 'dev' ? 'Updates are off in development builds' : 'Updates are off in this copy',
        }
    }
    if (activity.state === 'checking') return {key: 'checking', text: 'Checking for updates…'}
    if (activity.state === 'installing') return {key: 'installing', text: 'Starting the update…'}
    if (activity.state === 'downloading') {
        const percent = activity.total ? `${Math.floor((activity.received / activity.total) * 100)}%` : undefined
        return {key: 'downloading', text: `Downloading ${offer?.release.version ?? 'the update'}…`, value: percent}
    }
    // A failed automatic check shows only in Settings (status.rs).
    if (error && !error.background) return {key: `failed-${error.action}`, text: FAILED[error.action]}
    if (offer) {
        const {version} = offer.release
        if (offer.waitingForRecording) {
            return {key: 'waiting', text: `Update ${version} downloads after the recording`}
        }
        return offer.downloaded && !offer.manualOnly
            ? {key: 'ready', text: `Update ${version} is ready`}
            : {key: 'available', text: `Update ${version} is available`}
    }
    return snapshot.lastCheckedAt === null
        ? {key: 'unchecked', text: 'Not checked for updates yet'}
        : {key: 'current', text: 'Up to date'}
}

const Page = styled.div`
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: ${({theme}) => theme.space[6]};
`

const Frame = styled.main`
    display: flex;
    flex-direction: column;
    width: ${({theme}) => theme.sizes.window.width};
    height: ${({theme}) => theme.sizes.window.height};
    overflow: hidden;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.lg};
    background: ${({theme}) => theme.colors.bg};
`

const Header = styled.header`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    height: ${({theme}) => theme.sizes.bar.header};
    padding: 0 ${({theme}) => theme.space[4]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
`

const AppName = styled.span`
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
`

const Muted = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: ${({theme}) => theme.space[5]};
    min-height: 0;
    overflow-y: auto;
    padding: ${({theme}) => theme.space[5]} ${({theme}) => theme.space[6]};
`

const Section = styled.section`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
`

const SectionTitle = styled.h2`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

const Display = styled.p`
    ${({theme}) => theme.text.display};
`

const Title = styled.p`
    ${({theme}) => theme.text.title};
`

const BodyText = styled.p`
    color: ${({theme}) => theme.colors.soft};
`

const Timer = styled.span`
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.timer};
    font-variant-numeric: tabular-nums;
`

const Footer = styled.footer`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: ${({theme}) => theme.space[2]};
    height: ${({theme}) => theme.sizes.bar.footer};
    padding: 0 ${({theme}) => theme.space[4]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

const Hint = styled(Muted)`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

export function ShellPlaceholder() {
    const {data: version} = useQuery(appVersionQuery)
    const {data: updater, isError: updaterUnavailable} = useQuery(updaterStatusQuery)

    return (
        <Page>
            <Frame>
                <Header>
                    <AppName>Protocol</AppName>
                    <Muted>{version ?? '…'} · {PLATFORM_NAMES[platform]}</Muted>
                </Header>

                <Body>
                    <Section aria-labelledby="shell-theme">
                        <SectionTitle id="shell-theme">Theme</SectionTitle>
                        <ThemeSwitch/>
                    </Section>

                    <Section aria-labelledby="shell-type">
                        <SectionTitle id="shell-type">Type</SectionTitle>
                        <Display>Welcome to Protocol</Display>
                        <Title>Get ready for the first meeting</Title>
                        <BodyText>Protocol records your meetings and writes the transcript and summary for you.</BodyText>
                        <Muted>Geist for text, Geist Mono for timers and sizes.</Muted>
                        <Timer>12:04</Timer>
                    </Section>
                </Body>

                <Footer>
                    <Hint>
                        <MagnifyingGlassIcon aria-hidden/>
                        Search
                        <Kbd>{formatShortcut('K')}</Kbd>
                    </Hint>
                    <StatusLine status={describeUpdates(updater, updaterUnavailable)}/>
                </Footer>
            </Frame>
        </Page>
    )
}
