import {useQuery} from '@tanstack/react-query'
import {
    FolderSimpleIcon,
    GearIcon,
    MagnifyingGlassIcon,
    MicrophoneIcon,
    PushPinIcon,
    SpeakerHighIcon,
    StopIcon,
    WaveformIcon,
} from '@phosphor-icons/react'
import styled from 'styled-components'
import {appVersionQuery} from '@/api/app'
import {type UpdaterSnapshot, updaterStatusQuery} from '@/api/updater'
import {formatShortcut, platform, type Platform} from '@/lib/platform'
import type {ThemeColors} from '@/styles/theme'
import {ThemeSwitch} from './ThemeSwitch'

// A stand-in until the window shell and the screens arrive: one 460×700
// window showing the theme, the fonts and the icons on mock or native IPC.

const PLATFORM_NAMES: Record<Platform, string> = {macos: 'macOS', windows: 'Windows', linux: 'Linux'}

const SWATCHES: (keyof ThemeColors)[] = ['bg', 'surface', 'raised', 'text', 'soft', 'muted', 'border']

const ICONS = [
    {Icon: MicrophoneIcon, label: 'Microphone'},
    {Icon: SpeakerHighIcon, label: 'Computer audio'},
    {Icon: WaveformIcon, label: 'Transcript'},
    {Icon: StopIcon, label: 'Stop'},
    {Icon: MagnifyingGlassIcon, label: 'Search'},
    {Icon: FolderSimpleIcon, label: 'Folder'},
    {Icon: PushPinIcon, label: 'Keep on top'},
    {Icon: GearIcon, label: 'Settings'},
]

function describeUpdates(snapshot: UpdaterSnapshot | undefined): string {
    if (!snapshot) return 'Checking for updates…'
    if (snapshot.support.kind === 'off') {
        return snapshot.support.reason === 'dev' ? 'Updates are off in development builds' : 'Updates are off'
    }
    if (snapshot.offer) {
        const {version} = snapshot.offer.release
        return snapshot.offer.downloaded ? `Update ${version} is ready` : `Update ${version} is available`
    }
    return 'Up to date'
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

const Row = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

const Swatch = styled.figure`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    margin: 0;

    figcaption {
        ${({theme}) => theme.text.caption};
        color: ${({theme}) => theme.colors.muted};
    }
`

const Chip = styled.span<{ $token: keyof ThemeColors }>`
    width: ${({theme}) => theme.sizes.control.sm};
    height: ${({theme}) => theme.sizes.control.sm};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme, $token}) => theme.colors[$token]};
`

const IconBox = styled.span`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.control.sm};
    height: ${({theme}) => theme.sizes.control.sm};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.surface};
    color: ${({theme}) => theme.colors.muted};
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

const Kbd = styled.kbd`
    padding: 1px ${({theme}) => theme.space[1.5]};
    border-radius: ${({theme}) => theme.radii.xs};
    background: ${({theme}) => theme.colors.surface};
    color: ${({theme}) => theme.colors.muted};
    font-family: inherit;
    ${({theme}) => theme.text.caption};
`

export function ShellPlaceholder() {
    const {data: version} = useQuery(appVersionQuery)
    const {data: updater} = useQuery(updaterStatusQuery)

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

                    <Section aria-labelledby="shell-colors">
                        <SectionTitle id="shell-colors">Colors</SectionTitle>
                        <Row>
                            {SWATCHES.map((name) => (
                                <Swatch key={name}>
                                    <Chip $token={name}/>
                                    <figcaption>{name}</figcaption>
                                </Swatch>
                            ))}
                        </Row>
                    </Section>

                    <Section aria-labelledby="shell-icons">
                        <SectionTitle id="shell-icons">Icons</SectionTitle>
                        <Row>
                            {ICONS.map(({Icon, label}) => (
                                <IconBox key={label} title={label}>
                                    <Icon aria-label={label}/>
                                </IconBox>
                            ))}
                        </Row>
                    </Section>
                </Body>

                <Footer>
                    <Muted>
                        <Kbd>{formatShortcut('K')}</Kbd> Search
                    </Muted>
                    <Muted role="status">{describeUpdates(updater)}</Muted>
                </Footer>
            </Frame>
        </Page>
    )
}
