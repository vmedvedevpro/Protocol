/**
 * Settings › Recording: where recordings are saved, the microphone and the
 * computer audio with their volumes, and Import. Every value here is a field
 * of the native recording preferences, changed through
 * `useRecordingPreferences` so the fields no row shows are written back.
 */
import {useEffect, useEffectEvent, useRef, useState} from 'react'
import {useMutation} from '@tanstack/react-query'
import {XIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {type LevelFeed, useAudioLevelMonitoring} from '@/api/audio'
import {deviceLabel, MAX_GAIN, MIN_GAIN, type PerAppTarget, type RecordingPreferences} from '@/api/devices'
import {type RecordingPhase, useRecordingPhase} from '@/api/recordingPhase'
import {LevelMeter} from '@/components/ring/LevelMeter'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {SegmentedControl, type SegmentedOption} from '@/components/ui/SegmentedControl'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {focusRing} from '@/components/ui/styles'
import {Switch} from '@/components/ui/Switch'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'
import {platform as currentPlatform, type Platform} from '@/lib/platform'
import {tween} from '@/styles/motion'
import {openRecordingsFolder, pickRecordingsFolder} from '../api/recordingsFolder'
import {DeviceRow} from './PreferenceRows'
import {useRecordingPreferences} from '../hooks/useRecordingPreferences'
import {Warning} from './styles'

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
            description={`Saved as ${preferences.file_format.toUpperCase()}`}
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
                description="For playback and a better transcript after the meeting"
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

const SliderLine = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

const Range = styled.input`
    flex: 1;
    min-width: 0;
    height: ${({theme}) => theme.sizes.control.sm};
    margin: 0;
    background: transparent;
    accent-color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${focusRing};
`

const Times = styled.span`
    flex: none;
    min-width: 4ch;
    ${({theme}) => theme.text.small};
    font-variant-numeric: tabular-nums;
    color: ${({theme}) => theme.colors.muted};
    text-align: right;
`

// A drag writes the preferences once it rests this long, not on every step.
const GAIN_SAVE_MS = 250

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
    const [draft, setDraft] = useState<number | null>(null)
    const gain = draft ?? preferences?.[field] ?? 1

    // The last value not yet written, written when the drag rests or the row
    // goes away, so leaving the page mid-drag keeps it.
    const pending = useRef<number | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    const flush = () => {
        clearTimeout(timer.current)
        if (pending.current === null) return
        save({[field]: pending.current})
        pending.current = null
    }
    const flushOnLeave = useEffectEvent(flush)
    useEffect(() => () => flushOnLeave(), [])

    const change = (value: number) => {
        setDraft(value)
        pending.current = value
        clearTimeout(timer.current)
        timer.current = setTimeout(() => {
            flush()
            // The mutation has put the value in the query already.
            setDraft(null)
        }, GAIN_SAVE_MS)
    }

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
                <Times>{times(gain)}</Times>
                {meter && <LevelMeter level={feed}/>}
            </SliderLine>
        </SettingsRow>
    )
}

const Chips = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

const Chip = styled(m.span)`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    height: ${({theme}) => theme.sizes.control.sm};
    padding: 0 ${({theme}) => theme.space[1]} 0 ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.raised};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
`

const Remove = styled.button`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.pill};
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    cursor: pointer;
    ${focusRing};

    &:hover {
        background: ${({theme}) => theme.colors.surface};
        color: ${({theme}) => theme.colors.text};
    }
`

const chipMotion = {
    initial: {opacity: 0, scale: 0.9},
    animate: {opacity: 1, scale: 1},
    exit: {opacity: 0, scale: 0.9},
    transition: tween('fast'),
}

/** The apps whose sound alone is recorded; the chosen-apps page (#117) adds them. */
function ChosenAppsRow({targets}: {targets: PerAppTarget[]}) {
    const navigate = useNavigate()
    const {save} = useRecordingPreferences()
    return (
        <SettingsRow
            label="Chosen apps"
            description={targets.length ? 'Only their sound is recorded' : 'Add the apps of your calls'}
        >
            <Chips>
                <AnimatePresence initial={false} mode="popLayout">
                    {targets.map((target) => (
                        <Chip key={target.id} {...chipMotion}>
                            {target.name}
                            <Remove
                                type="button"
                                aria-label={`Remove ${target.name}`}
                                onClick={() => save({per_app_targets: targets.filter(({id}) => id !== target.id)})}
                            >
                                <XIcon size={11} aria-hidden/>
                            </Remove>
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
            {platform !== 'macos' && <DeviceRow type="Output" description="The other people in the call"/>}
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
    const chosen = preferences?.preferred_mic_device ?? null
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
                <DeviceRow type="Input" description="Your voice, labeled “You”" action={test}/>
                <GainRow label="Mic volume" field="mic_gain" meter={micFeed(phase, testing, mic)}/>
            </SettingsGroup>
            <ComputerAudioGroup platform={platform}/>
            <SettingsGroup title="Import">
                <SettingsRow
                    label="Import a recording"
                    description="Transcribe an audio or video file"
                    // Import itself is #119's; it wires this button.
                    control={<Button size="sm" disabled>Choose a file</Button>}
                />
            </SettingsGroup>
        </>
    )
}
