import {useEffect, useMemo, useState} from 'react'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import {useNavigate, useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {Screen} from '@/components/screen/Screen'
import {Crossfade, CrossfadeView} from '@/components/ui/Crossfade'
import {TabList, TabPanels, Tabs} from '@/components/ui/SegmentedControl'
import {SettingsGroup, SettingsNavRow, SettingsSearchScope} from '@/components/ui/SettingsRow'
import {matchesTerms, searchTerms} from '@/components/ui/settingsSearch'
import {Switch} from '@/components/ui/Switch'
import {TextField} from '@/components/ui/TextField'
import {Tooltip} from '@/components/ui/Tooltip'
import {paths} from '@/lib/paths'
import {AgentsGroup, DiskGroup} from '../components/AgentsGroup'
import {GeneralSection} from '../components/GeneralSection'
import {RecordingSection} from '../components/RecordingSection'
import {SimpleSettings} from '../components/SimpleSettings'
import {IntelOfferBanner} from '../components/speech/IntelOfferBanner'
import {SpeechCheckGroup} from '../components/speech/SpeechCheckGroup'
import {LabsGroup} from '../components/speech/LabsGroup'
import {LogsGroup} from '../components/LogsGroup'
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

// The four tabs, dense, and the search beside them while the row has
// room for the search's whole placeholder (sizes.settingsSearch); in a
// narrower window, down to the minimum 360 px, the search wraps to a full
// line under the tabs. Wrapping needs no width threshold, so it holds for
// any font rendering, and nothing in the row is ever cut (#202).
const TabRow = styled.div`
    display: flex;
    flex: none;
    flex-wrap: wrap;
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

// The tabs keep their width; the search takes what is left of the row,
// never less than the width its placeholder needs.
const Search = styled.div`
    flex: 1 0 ${({theme}) => theme.sizes.settingsSearch};
    min-width: ${({theme}) => theme.sizes.settingsSearch};
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
                    <SpeechCheckGroup/>
                    <DiskGroup/>
                    <AgentsGroup/>
                    <LabsGroup/>
                    <LogsGroup/>
                </>
            )
    }
}

const PAGE_IDS = Object.keys(SETTINGS_PAGES) as SettingsPageId[]

/** How many of a page's indexed rows match; its title counts as one. */
function pageMatches(id: SettingsPageId, terms: string[]) {
    const {title, rows} = SETTINGS_PAGES[id]
    const matched = rows.filter(({label, description}) => matchesTerms(terms, label, description)).length
    return matched + (matchesTerms(terms, title) ? 1 : 0)
}

/**
 * Settings search: every section's rows that match, under the section's
 * name, then the pages whose rows match. A section's rows check their own
 * text as they render; a page is looked up in its index
 * (`SETTINGS_PAGES[…].rows`), so nothing on a page loads for a search.
 */
function SearchResults({query}: {query: string}) {
    const navigate = useNavigate()
    const [counts, setCounts] = useState<Partial<Record<SettingsSection, number>>>({})
    const reporters = useMemo(() => Object.fromEntries(SETTINGS_SECTIONS.map(({value}) => [value, (count: number) =>
        setCounts((current) => (current[value] === count ? current : {...current, [value]: count}))])), [])
    const terms = searchTerms(query)
    const pages = PAGE_IDS.map((id) => ({id, count: pageMatches(id, terms)})).filter(({count}) => count > 0)
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0) + pages.length
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
                    {pages.map(({id, count}) => (
                        <SettingsNavRow
                            key={id}
                            label={SETTINGS_PAGES[id].title}
                            description={`${sectionLabel(SETTINGS_PAGES[id].section)}, ${count} matching`}
                            onClick={() => void navigate(paths.settingsPage(id))}
                        />
                    ))}
                </SettingsGroup>
            )}
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
    // The field shows `?q=`, and the router commits a navigation in a
    // transition. Until it commits, React keeps the field at the old value,
    // so keys typed while the first results render were lost. flushSync
    // commits each key before the next one arrives.
    const setQuery = (next: string) => setSearch((current) => {
        const params = new URLSearchParams(current)
        if (next) params.set('q', next)
        else params.delete('q')
        return params
    }, {replace: true, flushSync: true})

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
                                <TabList dense/>
                                <Search>
                                    <TextField
                                        type="search"
                                        size="sm"
                                        aria-label="Search settings"
                                        placeholder="Search"
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
