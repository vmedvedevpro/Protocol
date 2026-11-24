import {type ReactNode, useEffect} from 'react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import {useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {Switch} from '@/components/ui/Switch'
import {Screen} from '@/app/shell/Screen'
import {tween} from '@/styles/motion'
import {GeneralSection} from '../components/GeneralSection'
import {RecordingSection} from '../components/RecordingSection'
import {SimpleSettings} from '../components/SimpleSettings'
import {opensUpdates, sectionFromParam, SETTINGS_SECTIONS, type SettingsSection} from '../sections'
import {useAdvancedSettingsStore} from '../store/advanced'

const Head = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
`

const Title = styled.h1`
    flex: 1;
    min-width: 0;
    ${({theme}) => theme.text.screen};
`

const AdvancedLabel = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// The simple page and the sections share one grid cell, so switching between
// them crossfades in place.
const Views = styled.div`
    display: grid;
    flex: 1;
    grid-template: minmax(0, 1fr) / minmax(0, 1fr);
    min-height: 0;
`

const View = styled(m.div)`
    display: flex;
    grid-area: 1 / 1;
    flex-direction: column;
    min-height: 0;
`

const fade = {
    initial: {opacity: 0},
    animate: {opacity: 1},
    exit: {opacity: 0},
    transition: tween('base'),
}

const TabRow = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    padding: 0 ${({theme}) => theme.space[4]} ${({theme}) => theme.space[2.5]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
`

const Scroll = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

const Groups = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[5]};
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]} ${({theme}) => theme.space[6]};
`

const Note = styled.p`
    padding: 0 ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

/** A request to scroll General › Updates into view, until it has. */
interface Reveal {
    updates: boolean
    done: () => void
}

function Upcoming({children}: {children: ReactNode}) {
    return <Note>{children}</Note>
}

function SectionView({section, reveal}: {section: SettingsSection; reveal: Reveal}) {
    switch (section) {
        case 'general':
            return (
                <>
                    <Note>The defaults suit most meetings. What you change here stays when Advanced is off.</Note>
                    <GeneralSection revealUpdates={reveal.updates} onUpdatesRevealed={reveal.done}/>
                </>
            )
        case 'recording':
            return <RecordingSection/>
        case 'ai':
            return <Upcoming>Transcription, speakers, summaries and speech models arrive here with #117.</Upcoming>
        case 'advanced':
            return <Upcoming>Local AI, AI agents and Labs arrive here with #117.</Upcoming>
    }
}

/**
 * Settings: the simple page, or with Advanced on every section in tabs. The
 * section is in the URL (`?section=`), which also takes the old UI's ids:
 * one turns Advanced on, and `about` (the tray's Check for Updates…) lands
 * on General › Updates.
 */
export function SettingsPage() {
    const [search, setSearch] = useSearchParams()
    const param = search.get('section')
    const requested = sectionFromParam(param)
    const advanced = useAdvancedSettingsStore((state) => state.advanced)
    const setAdvanced = useAdvancedSettingsStore((state) => state.setAdvanced)
    const section = requested ?? 'general'

    // A link to a section shows the sections.
    useEffect(() => {
        if (requested) setAdvanced(true)
    }, [requested, setAdvanced])

    // Updates sit in General now. `about` stays in the URL until Updates has
    // scrolled itself into view, whenever the sections have appeared; then it
    // becomes `general`, so going back does not scroll again.
    const reveal: Reveal = {
        updates: opensUpdates(param),
        done: () => setSearch({section: 'general'}, {replace: true}),
    }

    const turnAdvanced = (on: boolean) => {
        setAdvanced(on)
        // The simple page has no sections.
        if (!on && param) setSearch({}, {replace: true})
    }

    return (
        <Screen>
            <Head>
                <Title>Settings</Title>
                <AdvancedLabel aria-hidden>Advanced</AdvancedLabel>
                <span title={advanced ? 'Hide advanced settings. Your choices stay as they are' : 'Show every setting'}>
                    <Switch label="Advanced settings" checked={advanced} onCheckedChange={turnAdvanced}/>
                </span>
            </Head>
            <Views>
                <AnimatePresence initial={false}>
                    {advanced ? (
                        <View key="advanced" {...fade}>
                            <Tabs
                                label="Settings sections"
                                options={SETTINGS_SECTIONS}
                                value={section}
                                onChange={(next) => setSearch({section: next}, {replace: true})}
                            >
                                {/* Search across the sections goes beside the tabs (#117). */}
                                <TabRow><TabList/></TabRow>
                                <TabPanels<SettingsSection>>
                                    {(shown) => <Groups><SectionView section={shown} reveal={reveal}/></Groups>}
                                </TabPanels>
                            </Tabs>
                        </View>
                    ) : (
                        <View key="simple" {...fade}>
                            <Scroll>
                                <Groups><SimpleSettings/></Groups>
                            </Scroll>
                        </View>
                    )}
                </AnimatePresence>
            </Views>
        </Screen>
    )
}
