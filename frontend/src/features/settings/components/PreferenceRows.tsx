/**
 * The rows the simple page and the sections share. Both views show the same
 * stored values, so a change in one is in the other.
 */
import type {ReactNode} from 'react'
import {useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {audioDevicesQuery, deviceInUse, deviceValue} from '@/api/devices'
import {builtInModelsQuery} from '@/api/models'
import {
    pinSummaryLanguage,
    summaryModelQuery,
    useAutoSummaryStore,
    useMeetingLanguageStore,
    useSummaryLanguageStore,
    useUserNameStore,
} from '@/api/preferences'
import {useRecordingBusy} from '@/api/recordingPhase'
import {SegmentedControl} from '@/components/ui/SegmentedControl'
import {Select, type SelectOption} from '@/components/ui/Select'
import {SettingsNavRow, SettingsRow} from '@/components/ui/SettingsRow'
import {Switch} from '@/components/ui/Switch'
import {TextField} from '@/components/ui/TextField'
import {MEETING_LANGUAGES, SUMMARY_LANGUAGES} from '@/lib/languages'
import {paths} from '@/lib/paths'
import {THEME_MODES, useThemeModeStore} from '@/styles/themeMode'
import {THEME_SWITCH_TRANSITION_NAME} from '@/styles/themeTransition'
import {useRecordingPreferences} from '../hooks/useRecordingPreferences'
import {describeSummaryModel} from './summaryModel'

const NameField = styled.div`
    flex: none;
    width: 130px;
`

/** The name that decorates the microphone's lines; first launch asks it too. */
export function NameRow() {
    const name = useUserNameStore((state) => state.value)
    const setName = useUserNameStore((state) => state.set)
    return (
        <SettingsRow
            label="Your name"
            control={(
                <NameField>
                    <TextField size="sm" value={name} placeholder="e.g. Tyler" onChange={(event) => setName(event.target.value)}/>
                </NameField>
            )}
        />
    )
}

// Out of the theme crossfade, shown only live (GlobalStyle): the thumb slides
// once instead of also standing still on the old option in the old frame.
const ThemeFrame = styled.div`
    display: flex;
    flex: none;
    view-transition-name: ${THEME_SWITCH_TRANSITION_NAME};
`

/** Light, Dark or Match system, for every window. */
export function ThemeRow() {
    const mode = useThemeModeStore((state) => state.mode)
    const setMode = useThemeModeStore((state) => state.setMode)
    return (
        <SettingsRow
            label="Theme"
            control={(
                <ThemeFrame>
                    <SegmentedControl label="Theme" options={THEME_MODES} value={mode} onChange={setMode}/>
                </ThemeFrame>
            )}
        />
    )
}

const DEFAULT_DEVICE = 'default'

const DeviceControls = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

interface DeviceRowProps {
    type: 'Input' | 'Output'
    /** A button beside the choice, such as the microphone's Test. */
    action?: ReactNode
}

/**
 * A microphone or an output to record, from the devices native can open now.
 * A saved device that is not connected shows the default chosen, which a
 * recording opens (`deviceInUse`), and the row says the saved one is
 * missing; the preference keeps it, so it is used again once it is back, and
 * only a choice the user makes writes the preference.
 */
export function DeviceRow({type, action}: DeviceRowProps) {
    const devices = useQuery(audioDevicesQuery)
    const {preferences, save} = useRecordingPreferences()
    const field = type === 'Input' ? 'preferred_mic_device' : 'preferred_system_device'
    const {device, missing} = deviceInUse(preferences?.[field], devices.data?.filter((each) => each.device_type === type))

    const options: SelectOption<string>[] = [
        {value: DEFAULT_DEVICE, label: type === 'Input' ? 'Default microphone' : 'Default output'},
        ...(devices.data ?? [])
            .filter((each) => each.device_type === type)
            .map((each) => ({value: deviceValue(each), label: each.name})),
    ]

    return (
        <SettingsRow
            label={type === 'Input' ? 'Microphone' : 'System audio'}
            description={missing ? `${missing} isn’t connected, so the default is used` : undefined}
            control={(
                <DeviceControls>
                    <Select
                        options={options}
                        value={preferences ? device ?? DEFAULT_DEVICE : undefined}
                        disabled={!preferences}
                        onValueChange={(value) => save({[field]: value === DEFAULT_DEVICE ? null : value})}
                    />
                    {action}
                </DeviceControls>
            )}
        />
    )
}

const MEETING_LANGUAGE_OPTIONS: SelectOption<string>[] = MEETING_LANGUAGES.map(({code, label}) => ({value: code, label}))

/**
 * The language people speak, which Whisper is told; Parakeet detects it.
 * A recording keeps the language it started with, so the choice is locked
 * from Record until the meeting is saved.
 */
export function MeetingLanguageRow() {
    const language = useMeetingLanguageStore((state) => state.value)
    const setLanguage = useMeetingLanguageStore((state) => state.set)
    const locked = useRecordingBusy()
    const options = MEETING_LANGUAGE_OPTIONS.some((option) => option.value === language)
        ? MEETING_LANGUAGE_OPTIONS
        : [...MEETING_LANGUAGE_OPTIONS, {value: language, label: language}]
    return (
        <SettingsRow
            label="Meeting language"
            description={locked ? 'Can’t change during a recording' : undefined}
            control={<Select options={options} value={language} disabled={locked} onValueChange={setLanguage}/>}
        />
    )
}

export function AutoSummaryRow() {
    const on = useAutoSummaryStore((state) => state.value)
    const setOn = useAutoSummaryStore((state) => state.set)
    return (
        <SettingsRow
            label="Summarize automatically"
            control={<Switch checked={on} onCheckedChange={setOn}/>}
        />
    )
}

const SAME_AS_MEETING = 'meeting'

const SUMMARY_LANGUAGE_OPTIONS: SelectOption<string>[] = [
    {value: SAME_AS_MEETING, label: 'Same as the meeting'},
    ...SUMMARY_LANGUAGES.map(({code, label}) => ({value: code, label})),
]

/** A language every summary is written in, or the one most of the meeting was spoken in. */
export function SummaryLanguageRow() {
    const pinned = useSummaryLanguageStore((state) => state.value)
    return (
        <SettingsRow
            label="Summary language"
            control={(
                <Select
                    options={SUMMARY_LANGUAGE_OPTIONS}
                    value={pinned ?? SAME_AS_MEETING}
                    onValueChange={(value) => pinSummaryLanguage(value === SAME_AS_MEETING ? null : value)}
                />
            )}
        />
    )
}

/** The model that writes summaries; its page changes it. */
export function SummaryModelRow() {
    const navigate = useNavigate()
    const config = useQuery(summaryModelQuery)
    const builtIn = config.data?.provider === 'builtin-ai'
    const models = useQuery({...builtInModelsQuery, enabled: builtIn})
    const builtInName = models.data?.find(({name}) => name === config.data?.model)?.display_name
    const {value, description} = config.isSuccess ? describeSummaryModel(config.data, builtInName) : {value: '', description: undefined}
    return (
        <SettingsNavRow
            label="Summary model"
            description={description}
            value={value}
            onClick={() => void navigate(paths.settingsPage('summary-model'))}
        />
    )
}
