import {useQuery} from '@tanstack/react-query'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {appVersionQuery} from '@/api/app'
import {type UpdateError, type UpdaterSnapshot, updaterStatusQuery} from '@/api/updater'
import {formatShortcut, platform, type Platform} from '@/lib/platform'
import {tween} from '@/styles/motion'
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

// The order of Settings › About on main: what the updater is doing, then a
// failure the user saw happen, then the offer, then the last check.
function describeUpdates(snapshot: UpdaterSnapshot | undefined, unavailable: boolean): string {
    if (!snapshot) return unavailable ? 'Update status unavailable' : 'Reading update status…'
    const {support, activity, error, offer} = snapshot
    if (support.kind === 'off') {
        return support.reason === 'dev' ? 'Updates are off in development builds' : 'Updates are off in this copy'
    }
    if (activity.state === 'checking') return 'Checking for updates…'
    if (activity.state === 'installing') return 'Starting the update…'
    if (activity.state === 'downloading') {
        const percent = activity.total ? ` ${Math.floor((activity.received / activity.total) * 100)}%` : ''
        return `Downloading ${offer?.release.version ?? 'the update'}…${percent}`
    }
    // A failed automatic check shows only in Settings (status.rs).
    if (error && !error.background) return FAILED[error.action]
    if (offer) {
        const {version} = offer.release
        if (offer.waitingForRecording) return `Update ${version} downloads after the recording`
        return offer.downloaded && !offer.manualOnly ? `Update ${version} is ready` : `Update ${version} is available`
    }
    return snapshot.lastCheckedAt === null ? 'Not checked for updates yet' : 'Up to date'
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

const Kbd = styled.kbd`
    padding: 1px ${({theme}) => theme.space[1.5]};
    border-radius: ${({theme}) => theme.radii.xs};
    background: ${({theme}) => theme.colors.surface};
    color: ${({theme}) => theme.colors.muted};
    font-family: inherit;
    ${({theme}) => theme.text.caption};
`

// A transform needs a box; a plain inline span would ignore it.
const StatusText = styled(m.span)`
    display: inline-block;
`

// A status that changes in place: the old line leaves upwards, the new one
// arrives from below (only the fade under reduced motion).
function UpdateStatus({status}: { status: string }) {
    return (
        <Muted role="status">
            <AnimatePresence mode="wait" initial={false}>
                <StatusText
                    key={status}
                    initial={{opacity: 0, y: 4}}
                    animate={{opacity: 1, y: 0}}
                    exit={{opacity: 0, y: -4}}
                    transition={tween('fast')}
                >
                    {status}
                </StatusText>
            </AnimatePresence>
        </Muted>
    )
}

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
                    <UpdateStatus status={describeUpdates(updater, updaterUnavailable)}/>
                </Footer>
            </Frame>
        </Page>
    )
}
