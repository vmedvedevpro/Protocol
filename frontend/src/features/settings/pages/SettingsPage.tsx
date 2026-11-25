import {useEffect, useMemo, useState} from 'react'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import {useNavigate, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {Screen} from '@/components/screen/Screen'
import {Crossfade, CrossfadeView} from '@/components/ui/Crossfade'
import {TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {SettingsGroup, SettingsNavRow, SettingsSearchScope} from '@/components/ui/SettingsRow'
import {Switch} from '@/components/ui/Switch'
import {TextField} from '@/components/ui/TextField'
import {Tooltip} from '@/components/ui/Tooltip'
import {paths} from '@/lib/paths'
import {AgentsGroup, DiskGroup} from '../components/AgentsGroup'
import {GeneralSection} from '../components/GeneralSection'
import {RecordingSection} from '../components/RecordingSection'
import {SimpleSettings} from '../components/SimpleSettings'
import {IntelOfferBanner} from '../components/speech/IntelOfferBanner'
import {LabsGroup} from '../components/speech/LabsGroup'
import {LocalAiGroup} from '../components/speech/LocalAiGroup'
import {SpeechModelsGroup, TranscriptionGroups} from '../components/speech/TranscriptionGroups'
import {SummariesGroup} from '../components/SummariesGroup'
import {SETTINGS_PAGES, type SettingsPageId} from './settingsPages'
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

const Search = styled.div`
    flex: 1;
    max-width: 240px;
    margin-left: auto;
`

const Results = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
`

/**
 * A section's groups. The speech half of #117 puts its own groups around
 * the summaries (transcription before, speech models after) and around
 * the agents (Local AI before, Labs after). The notes speak of the section
 * as a whole, so search leaves them out.
 */
function SectionView({section, searching = false}: {section: SettingsSection, searching?: boolean}) {
    switch (section) {
        case 'general':
            return (
                <>
                    {!searching && <Note>The defaults suit most meetings. What you change here stays when Advanced is off.</Note>}
                    <GeneralSection/>
                </>
            )
        case 'recording':
            return <RecordingSection/>
        case 'ai':
            return (
                <>
                    {!searching && <IntelOfferBanner/>}
                    <TranscriptionGroups/>
                    <SummariesGroup/>
                    <SpeechModelsGroup/>
                </>
            )
        case 'advanced':
            return (
                <>
                    <LocalAiGroup/>
                    <DiskGroup/>
                    <AgentsGroup/>
                    <LabsGroup/>
                </>
            )
    }
}

const PAGE_IDS = Object.keys(SETTINGS_PAGES) as SettingsPageId[]

const noop = () => undefined

/**
 * Settings search: every section's rows that match, under the section's
 * name, then the pages whose rows match. Nothing is listed by hand: each
 * section and page renders under its own scope and reports how many of its
 * rows match; a page renders out of sight, and its row opens it.
 */
function SearchResults({query}: {query: string}) {
    const navigate = useNavigate()
    const [counts, setCounts] = useState<Record<string, number>>({})
    const reporters = useMemo(() => {
        const keys = [...SETTINGS_SECTIONS.map(({value}) => value), ...PAGE_IDS.map((id) => `page:${id}`)]
        return Object.fromEntries(keys.map((key) => [key, (count: number) =>
            setCounts((current) => (current[key] === count ? current : {...current, [key]: count}))]))
    }, [])
    const pages = PAGE_IDS.filter((id) => (counts[`page:${id}`] ?? 0) > 0)
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0)
    const sectionLabel = (section: SettingsSection) => SETTINGS_SECTIONS.find(({value}) => value === section)?.label

    return (
        <Groups>
            {SETTINGS_SECTIONS.map(({value, label}) => (
                <SettingsSearchScope key={value} query={query} scope={label} onMatches={reporters[value]}>
                    <SectionView section={value} searching/>
                </SettingsSearchScope>
            ))}
            {pages.length > 0 && (
                <SettingsGroup title="Pages">
                    {pages.map((id) => (
                        <SettingsNavRow
                            key={id}
                            label={SETTINGS_PAGES[id].title}
                            description={`${sectionLabel(SETTINGS_PAGES[id].section)} · ${counts[`page:${id}`]} matching`}
                            onClick={() => void navigate(paths.settingsPage(id))}
                        />
                    ))}
                </SettingsGroup>
            )}
            <div hidden>
                {PAGE_IDS.map((id) => {
                    const {Page} = SETTINGS_PAGES[id]
                    return (
                        <SettingsSearchScope key={id} query={query} onMatches={reporters[`page:${id}`]}>
                            <Page back={noop}/>
                        </SettingsSearchScope>
                    )
                })}
            </div>
            {total === 0 && <Note>Nothing matches “{query.trim()}”.</Note>}
        </Groups>
    )
}

/**
 * Settings: the simple page, or with Advanced on every section in tabs. The
 * section is in the URL (`?section=`), which also takes the old UI's ids:
 * one turns Advanced on, and `about` (the tray's Check for Updates…) lands
 * on General › Updates. A search is there too (`?q=`); picking a section
 * leaves it.
 */
export function SettingsPage() {
    const [search, setSearch] = useSearchParams()
    const param = search.get('section')
    const requested = sectionFromParam(param)
    const advanced = useAdvancedSettingsStore((state) => state.advanced)
    const setAdvanced = useAdvancedSettingsStore((state) => state.setAdvanced)
    const section = requested ?? 'general'
    const query = search.get('q') ?? ''
    const searching = query.trim() !== ''
    const setQuery = (next: string) => setSearch((current) => {
        const params = new URLSearchParams(current)
        if (next) params.set('q', next)
        else params.delete('q')
        return params
    }, {replace: true})

    // A link to a section shows the sections.
    useEffect(() => {
        if (requested) setAdvanced(true)
    }, [requested, setAdvanced])

    const turnAdvanced = (on: boolean) => {
        setAdvanced(on)
        // The simple page has no sections and no search.
        if (!on && (param || query)) setSearch({}, {replace: true})
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
                            <TabRow>
                                <TabList/>
                                <Search>
                                    <TextField
                                        type="search"
                                        size="sm"
                                        aria-label="Search settings"
                                        placeholder="Search settings"
                                        icon={<MagnifyingGlassIcon size={13} aria-hidden/>}
                                        value={query}
                                        onChange={(event) => setQuery(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Escape' && query) {
                                                event.preventDefault()
                                                setQuery('')
                                            }
                                        }}
                                    />
                                </Search>
                            </TabRow>
                            <Crossfade>
                                {searching ? (
                                    <View key="search">
                                        <Results><SearchResults query={query}/></Results>
                                    </View>
                                ) : (
                                    <View key="sections">
                                        <TabPanels<SettingsSection>>
                                            {(shown) => <Groups><SectionView section={shown}/></Groups>}
                                        </TabPanels>
                                    </View>
                                )}
                            </Crossfade>
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
