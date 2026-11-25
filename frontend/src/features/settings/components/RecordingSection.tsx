/**
 * Settings › Recording: where recordings are saved, the microphone and the
 * computer audio with their volumes, and Import. Every value here is a field
 * of the native recording preferences, changed through
 * `useRecordingPreferences` so the fields no row shows are written back.
 */
import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {XIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {type LevelFeed, useAudioLevelMonitoring} from '@/api/audio'
import {audioDevicesQuery, deviceInUse, deviceLabel, MAX_GAIN, MIN_GAIN, type PerAppTarget, type RecordingPreferences} from '@/api/devices'
import {type RecordingPhase, useRecordingPhase} from '@/api/recordingPhase'
import {LevelMeter} from '@/components/ring/LevelMeter'
import {Button} from '@/components/ui/Button'
import {Veil} from '@/components/ui/Veil'
import {Collapse} from '@/components/ui/Collapse'
import {SegmentedControl, type SegmentedOption} from '@/components/ui/SegmentedControl'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Switch} from '@/components/ui/Switch'
import {toast} from '@/components/ui/toastStore'
import {openDialog} from '@/lib/dialogs'
import {paths} from '@/lib/paths'
import {platform as currentPlatform, type Platform} from '@/lib/platform'
import {openRecordingsFolder, pickRecordingsFolder} from '../api/recordingsFolder'
import {DeviceRow} from './PreferenceRows'
import {Range, SliderLine, SliderValue} from './styles'
import {useDebouncedSave} from '@/lib/useDebouncedSave'
import {useRecordingPreferences} from '../hooks/useRecordingPreferences'
import {Chip, chipMotion, ChipButton, Chips, Warning} from './styles'

const Actions = styled.div`
    display: flex;
    flex: none;
    gap: ${({theme}) => theme.space[1.5]};
`

const Path = styled.code`
    display: block;
    padding: ${({theme}) => theme.space[1.5]} ${({theme}) => theme.space[2]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.bg};
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.soft};
    overflow-wrap: anywhere;
`

/** The folder recordings go to, with Change and Open. */
function FolderRow({preferences}: {preferences: RecordingPreferences}) {
    const {save} = useRecordingPreferences()
    const change = useMutation({
        mutationFn: pickRecordingsFolder,
        onSuccess: (picked) => {
            // Cancel in the picker answers null and changes nothing.
            if (picked) save({save_folder: picked}, () => toast.success('Recordings folder changed', {description: picked}))
        },
        onError: (error) => toast.error('Couldn’t change the recordings folder', {description: error.message}),
    })
    const open = useMutation({
        mutationFn: openRecordingsFolder,
        onError: (error) => toast.error('Couldn’t open the recordings folder', {description: error.message}),
    })
    return (
        <SettingsRow
            label="Where recordings are saved"
            control={(
                <Actions>
                    <Button size="sm" pending={change.isPending} onClick={() => change.mutate()}>Change</Button>
                    <Button size="sm" onClick={() => open.mutate()}>Open</Button>
                </Actions>
            )}
        >
            <Path>{preferences.save_folder}</Path>
        </SettingsRow>
    )
}

function SavingGroup() {
    const {preferences, save} = useRecordingPreferences()
    const on = preferences?.auto_save ?? true
    return (
        <SettingsGroup title="Saving">
            <SettingsRow
                label="Save audio"
                control={<Switch checked={on} disabled={!preferences} onCheckedChange={(auto_save) => save({auto_save})}/>}
            >
                <Collapse open={!on}>
                    <Warning>Audio isn’t being saved. You won’t be able to play meetings back or improve their transcripts.</Warning>
                </Collapse>
            </SettingsRow>
            <Collapse open={on && preferences !== undefined}>
                {preferences && <FolderRow preferences={preferences}/>}
            </Collapse>
        </SettingsGroup>
    )
}

const times = (gain: number) => `${gain.toFixed(1)}×`

/**
 * A volume, 0.5× to 3×, that native applies to the source while it records.
 * The meter beside it shows the level the slider would give.
 */
function GainRow({label, field, meter}: {
    label: string
    field: 'mic_gain' | 'system_gain'
    meter?: (gain: number) => LevelFeed | null
}) {
    const {preferences, save} = useRecordingPreferences()
    const {draft, change} = useDebouncedSave((value: number) => save({[field]: value}))
    const gain = draft ?? preferences?.[field] ?? 1

    const feed = meter?.(gain) ?? null
    return (
        <SettingsRow label={label}>
            <SliderLine>
                <Range
                    type="range"
                    aria-label={label}
                    aria-valuetext={times(gain)}
                    min={MIN_GAIN}
                    max={MAX_GAIN}
                    step={0.1}
                    value={gain}
                    disabled={!preferences}
                    onChange={(event) => change(Number(event.target.value))}
                />
                <SliderValue>{times(gain)}</SliderValue>
                {meter && <LevelMeter level={feed}/>}
            </SliderLine>
        </SettingsRow>
    )
}

/** The apps whose sound alone is recorded; the chosen-apps page (#117) adds them. */
function ChosenAppsRow({targets}: {targets: PerAppTarget[]}) {
    const navigate = useNavigate()
    const {save} = useRecordingPreferences()
    return (
        <SettingsRow label="Chosen apps">
            <Chips>
                <AnimatePresence initial={false} mode="popLayout">
                    {targets.map((target) => (
                        <Chip key={target.id} {...chipMotion}>
                            {target.name}
                            <ChipButton
                                type="button"
                                aria-label={`Remove ${target.name}`}
                                onClick={() => save({per_app_targets: targets.filter(({id}) => id !== target.id)})}
                            >
                                <XIcon size={11} aria-hidden/>
                            </ChipButton>
                            <Veil duration="fast" outset={1}/>
                        </Chip>
                    ))}
                </AnimatePresence>
                <Button variant="ghost" size="sm" onClick={() => void navigate(paths.settingsPage('chosen-apps'))}>
                    + Add app
                </Button>
            </Chips>
        </SettingsRow>
    )
}

type CaptureScope = 'all' | 'chosen'

const CAPTURE_SCOPES: readonly SegmentedOption<CaptureScope>[] = [
    {value: 'all', label: 'All computer audio'},
    {value: 'chosen', label: 'Only chosen apps'},
]

/**
 * What the other people in the call sound through. Windows and macOS can
 * record chosen apps only; Linux records the output. macOS has no output to
 * choose: it records the current one.
 */
function ComputerAudioGroup({platform}: {platform: Platform}) {
    const {preferences, save} = useRecordingPreferences()
    const perApp = preferences?.per_app_recording_enabled ?? false
    const canChooseApps = platform !== 'linux'
    const note = platform === 'macos'
        ? `macOS records the current system output${perApp ? '; with chosen apps, the first one that is open.' : '.'}`
        : undefined
    return (
        <SettingsGroup title="Computer audio" note={note}>
            {canChooseApps && (
                <SettingsRow
                    label="Record"
                    control={(
                        <SegmentedControl
                            label="Record"
                            options={CAPTURE_SCOPES}
                            value={perApp ? 'chosen' : 'all'}
                            onChange={(scope) => save({per_app_recording_enabled: scope === 'chosen'})}
                        />
                    )}
                />
            )}
            {canChooseApps && (
                <Collapse open={perApp}>
                    <ChosenAppsRow targets={preferences?.per_app_targets ?? []}/>
                </Collapse>
            )}
            {platform !== 'macos' && <DeviceRow type="Output"/>}
            <GainRow label="System volume" field="system_gain"/>
        </SettingsGroup>
    )
}

/**
 * The microphone meter's feed: the device preview while a test runs, the
 * recording's own microphone level while one runs (nothing is opened for
 * it), and at rest otherwise.
 */
function micFeed(phase: RecordingPhase, testing: boolean, device: string | null): (gain: number) => LevelFeed | null {
    if (phase === 'recording' || phase === 'paused') return () => ({kind: 'recording', source: 'mic'})
    if (!testing) return () => null
    return (gain) => ({kind: 'device', type: 'input', device: device ?? undefined, gain})
}

interface RecordingSectionProps {
    /** The platform whose options show; the running one outside stories and tests. */
    platform?: Platform
}

export function RecordingSection({platform = currentPlatform}: RecordingSectionProps) {
    const {preferences} = useRecordingPreferences()
    const phase = useRecordingPhase()
    const idle = phase === 'idle'
    // A saved microphone that is not connected is tested as the default, which a recording opens.
    const devices = useQuery(audioDevicesQuery)
    const chosen = deviceInUse(preferences?.preferred_mic_device, devices.data).device
    const mic = chosen ? deviceLabel(chosen) : null

    // Only Test opens the microphone. A test belongs to the device it was
    // started for: choosing another ends it, and the next one uses the new
    // device. A recording ends it too, since it takes the device; it does
    // not come back on its own afterwards.
    const [testedFor, setTestedFor] = useState<string | null>(null)
    const device = chosen ?? 'default'
    if (!idle && testedFor !== null) setTestedFor(null)
    const testing = idle && testedFor === device
    // The chosen microphone by name; with the default one, native's defaults,
    // which open the default output too (its level is not shown). Leaving the
    // section stops it.
    useAudioLevelMonitoring(testing ? (mic ? [mic] : []) : null)

    const test = (
        <Button size="sm" disabled={!preferences || !idle} onClick={() => setTestedFor(testing ? null : device)}>
            {testing ? 'Stop' : 'Test'}
        </Button>
    )

    return (
        <>
            <SavingGroup/>
            <SettingsGroup title="Microphone">
                <DeviceRow type="Input" action={test}/>
                <GainRow label="Mic volume" field="mic_gain" meter={micFeed(phase, testing, mic)}/>
            </SettingsGroup>
            <ComputerAudioGroup platform={platform}/>
            <SettingsGroup title="Import">
                <SettingsRow
                    label="Import a recording"
                    control={<Button size="sm" onClick={() => openDialog({kind: 'import'})}>Choose a file</Button>}
                />
            </SettingsGroup>
        </>
    )
}
