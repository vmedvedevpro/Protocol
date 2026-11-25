import {PushPinIcon, XIcon} from '@phosphor-icons/react'
import {useQuery} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import {useNavigate} from 'react-router-dom'
import {
    addRecentSummaryLanguage,
    MAX_RECENT_SUMMARY_LANGUAGES,
    pinSummaryLanguage,
    removeRecentSummaryLanguage,
    useRecentSummaryLanguagesStore,
    useSummaryLanguageStore,
} from '@/api/preferences'
import {defaultTemplateQuery, templatesQuery} from '@/api/templates'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsNavRow, SettingsRow} from '@/components/ui/SettingsRow'
import {Veil} from '@/components/ui/Veil'
import {SUMMARY_LANGUAGES, summaryLanguageLabel} from '@/lib/languages'
import {paths} from '@/lib/paths'
import {AutoSummaryRow, SummaryModelRow} from './PreferenceRows'
import {Chip, chipMotion, ChipButton, Chips} from './styles'

/**
 * The summary languages used lately as chips, the full version of the
 * simple page's select: a pinned one writes every summary, none follows
 * the meeting. "+ Add language" puts one on the list without pinning it.
 */
function SummaryLanguagesRow() {
    const recents = useRecentSummaryLanguagesStore((state) => state.value)
    const pinned = useSummaryLanguageStore((state) => state.value)
    const others = SUMMARY_LANGUAGES
        .filter(({code}) => !recents.includes(code))
        .map(({code, label}) => ({value: code, label}))
    return (
        <SettingsRow
            label="Summary language"
            description={pinned
                ? `Summaries are written in ${summaryLanguageLabel(pinned)}. Unpin to match the meeting`
                : 'Matches the language spoken in the meeting. Pin one to always use it'}
        >
            <Chips>
                <AnimatePresence initial={false} mode="popLayout">
                    {recents.map((code) => {
                        const label = summaryLanguageLabel(code)
                        const on = pinned === code
                        return (
                            <Chip key={code} {...chipMotion} $selected={on}>
                                {label}
                                <ChipButton
                                    type="button"
                                    aria-label={on ? `Unpin ${label}` : `Always write summaries in ${label}`}
                                    aria-pressed={on}
                                    onClick={() => pinSummaryLanguage(on ? null : code)}
                                >
                                    <PushPinIcon size={11} weight={on ? 'fill' : 'regular'} aria-hidden/>
                                </ChipButton>
                                <ChipButton type="button" aria-label={`Remove ${label}`} onClick={() => removeRecentSummaryLanguage(code)}>
                                    <XIcon size={11} aria-hidden/>
                                </ChipButton>
                                <Veil duration="fast" outset={1}/>
                            </Chip>
                        )
                    })}
                </AnimatePresence>
                {recents.length < MAX_RECENT_SUMMARY_LANGUAGES && (
                    <Select
                        label="Add a summary language"
                        placeholder="+ Add language"
                        options={others}
                        // Always empty: a choice joins the chips and the select asks again.
                        value={undefined}
                        onValueChange={addRecentSummaryLanguage}
                    />
                )}
            </Chips>
        </SettingsRow>
    )
}

/** The template every summary uses unless its meeting picks another. */
function TemplatesRow() {
    const navigate = useNavigate()
    const templates = useQuery(templatesQuery)
    const chosen = useQuery(defaultTemplateQuery)
    const name = templates.data?.find(({id}) => id === chosen.data)?.name
    return (
        <SettingsNavRow
            label="Templates"
            description="The sections a summary is written in"
            value={name ?? ''}
            onClick={() => void navigate(paths.settingsPage('templates'))}
        />
    )
}

/** Settings › AI › Summaries: the simple page's summary rows in full. */
export function SummariesGroup() {
    return (
        <SettingsGroup title="Summaries">
            <AutoSummaryRow description="When a recording is saved"/>
            <SummaryLanguagesRow/>
            <SummaryModelRow/>
            <TemplatesRow/>
        </SettingsGroup>
    )
}
