import {useEffect} from 'react'
import {useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {Screen} from '@/components/screen/Screen'
import {Crossfade, CrossfadeView} from '@/components/ui/Crossfade'
import {TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {Switch} from '@/components/ui/Switch'
import {Tooltip} from '@/components/ui/Tooltip'
import {GeneralSection} from '../components/GeneralSection'
import {RecordingSection} from '../components/RecordingSection'
import {SimpleSettings} from '../components/SimpleSettings'
import {sectionFromParam, SETTINGS_SECTIONS, type SettingsSection} from '../sections'
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

const View = styled(CrossfadeView)`
    display: flex;
    flex-direction: column;
`

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

function SectionView({section}: {section: SettingsSection}) {
    switch (section) {
        case 'general':
            return (
                <>
                    <Note>The defaults suit most meetings. What you change here stays when Advanced is off.</Note>
                    <GeneralSection/>
                </>
            )
        case 'recording':
            return <RecordingSection/>
        case 'ai':
            return <Note>Transcription, speakers, summaries and speech models arrive here with #117.</Note>
        case 'advanced':
            return <Note>Local AI, AI agents and Labs arrive here with #117.</Note>
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
                {/* The Switch takes no ref; the span gives the tooltip its anchor. */}
                <Tooltip content={advanced ? 'Hide advanced settings. Your choices stay as they are' : 'Show every setting'}>
                    <span>
                        <Switch label="Advanced settings" checked={advanced} onCheckedChange={turnAdvanced}/>
                    </span>
                </Tooltip>
            </Head>
            <Crossfade>
                {advanced ? (
                    <View key="advanced">
                        <Tabs
                            label="Settings sections"
                            options={SETTINGS_SECTIONS}
                            value={section}
                            onChange={(next) => setSearch({section: next}, {replace: true})}
                        >
                            {/* Search across the sections goes beside the tabs (#117). */}
                            <TabRow><TabList/></TabRow>
                            <TabPanels<SettingsSection>>
                                {(shown) => <Groups><SectionView section={shown}/></Groups>}
                            </TabPanels>
                        </Tabs>
                    </View>
                ) : (
                    <View key="simple">
                        <Scroll>
                            <Groups><SimpleSettings/></Groups>
                        </Scroll>
                    </View>
                )}
            </Crossfade>
        </Screen>
    )
}
