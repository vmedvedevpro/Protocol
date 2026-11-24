import {CaretDownIcon, CheckCircleIcon, MicrophoneIcon, SpeakerHighIcon, WarningIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import styled from 'styled-components'
import {type LevelFeed, useAudioLevelMonitoring} from '@/api/audio'
import {
    type AudioDevice,
    audioDevicesQuery,
    deviceLabel,
    deviceValue,
    recordingPreferencesQuery,
    updateRecordingPreferencesMutation,
} from '@/api/devices'
import {microphoneAccessQuery, openPrivacySettings, type PrivacyPane} from '@/api/permissions'
import {Ring} from '@/components/ring/Ring'
import {Button} from '@/components/ui/Button'
import {Menu, MenuRadioGroup, MenuRadioItem} from '@/components/ui/Menu'
import type {Platform} from '@/lib/platform'
import {tween} from '@/styles/motion'
import {useComputerAudioTest} from '../hooks/useComputerAudioTest'

const Card = styled.section`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    margin-top: ${({theme}) => theme.space[3.5]};
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[3]} ${({theme}) => theme.space[3]} ${({theme}) => theme.space[1]};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.surface};
`

const RingBox = styled.div`
    flex: none;
    align-self: flex-start;
`

const Body = styled.div`
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
`

const Prompt = styled(m.div)`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[0.5]};
`

const Heading = styled.h2`
    ${({theme}) => theme.text.body};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Hint = styled.p`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Chips = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: ${({theme}) => theme.space[1.5]};
    margin-top: ${({theme}) => theme.space[1.5]};
`

// A long device name ends in an ellipsis instead of widening the card.
const ChipText = styled.span`
    max-width: 160px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`

const Note = styled(m.div)`
    ${({theme}) => theme.text.small};
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: ${({theme}) => theme.space[1]} ${({theme}) => theme.space[1.5]};
    margin-top: ${({theme}) => theme.space[2]};
    color: ${({theme}) => theme.colors.muted};

    > svg {
        flex: none;
    }
`

const swap = {
    initial: {opacity: 0, y: 4},
    animate: {opacity: 1, y: 0},
    exit: {opacity: 0, y: -4},
    transition: tween('fast'),
}

const SYSTEM_DEFAULT = 'default'

/**
 * The devices the preview opens. An empty list opens the system's default
 * microphone and output. macOS records the computer through Audio Capture,
 * not a device, so it previews the microphone alone; elsewhere the output
 * is previewed beside it for "Test computer audio", the first one listed
 * standing in for a default that is not named, as in the old audio test.
 */
function previewNames(platform: Platform, mic: string | null, output: string | null, devices: AudioDevice[]): string[] {
    if (platform === 'macos') return mic ? [mic] : []
    if (!mic && !output) return []
    const first = (type: AudioDevice['device_type']) => devices.find(({device_type}) => device_type === type)?.name
    return [mic ?? first('Input'), output ?? first('Output')].filter((name): name is string => Boolean(name))
}

function SettingsButton({pane}: { pane: PrivacyPane }) {
    return (
        <Button size="sm" variant="ghost" onClick={() => void openPrivacySettings(pane)}>
            Open System Settings
        </Button>
    )
}

/**
 * The microphone check: the ring follows the microphone, which is asked for
 * first, so the system's prompt comes from a step that explains it; the
 * microphone can be changed here, and "Test computer audio" checks the
 * other source a meeting records, asking macOS's Audio Capture permission.
 */
export function MicCheck({platform}: { platform: Platform }) {
    const access = useQuery({...microphoneAccessQuery, retry: false})
    const devices = useQuery(audioDevicesQuery)
    const preferences = useQuery(recordingPreferencesQuery)
    const update = useMutation(updateRecordingPreferencesMutation())

    const storedMic = preferences.data?.preferred_mic_device ?? null
    const storedOutput = preferences.data?.preferred_system_device ?? null
    const mic = storedMic && deviceLabel(storedMic)
    const output = storedOutput && deviceLabel(storedOutput)
    const inputs = devices.data?.filter(({device_type}) => device_type === 'Input') ?? []

    const outputFeed: LevelFeed = {kind: 'device', type: 'output', device: output ?? undefined}
    const {test, start, feed: computerFeed} = useComputerAudioTest(platform, outputFeed)

    // Opened once the microphone was asked for, and the stored choice read.
    const ready = access.data !== undefined && preferences.data !== undefined && devices.data !== undefined
    useAudioLevelMonitoring(ready ? previewNames(platform, mic, output, devices.data) : null)

    const denied = access.data === false || access.isError
    const listening = test.state === 'listening'
    const micFeed: LevelFeed = {kind: 'device', type: 'input', device: mic ?? undefined}

    let note = null
    if (denied) {
        note = (
            <Note key="micDenied" {...swap}>
                <WarningIcon size={14}/>
                <span>Protocol can’t open the microphone.</span>
                {platform === 'macos' && <SettingsButton pane="Privacy_Microphone"/>}
                <Button size="sm" variant="ghost" pending={access.isFetching} onClick={() => void access.refetch()}>Try again</Button>
            </Note>
        )
    } else if (test.state === 'heard') {
        note = (
            <Note key="heard" {...swap}>
                <CheckCircleIcon size={14}/>
                <span>Protocol hears your computer audio.</span>
            </Note>
        )
    } else if (test.state === 'silent') {
        note = test.denied ? (
            <Note key="audioDenied" {...swap}>
                <WarningIcon size={14}/>
                <span>macOS doesn’t let Protocol record the computer audio.</span>
                <SettingsButton pane="Privacy_AudioCapture"/>
            </Note>
        ) : (
            <Note key="silent" {...swap}>
                <WarningIcon size={14}/>
                <span>Protocol heard no computer audio. Play something and test again.</span>
            </Note>
        )
    }

    return (
        <Card aria-labelledby="first-launch-mic">
            <RingBox>
                <Ring mode={denied ? 'idle' : 'test'} size={72} level={computerFeed ?? micFeed}/>
            </RingBox>
            <Body>
                <AnimatePresence mode="wait" initial={false}>
                    {listening ? (
                        <Prompt key="computer" {...swap}>
                            <Heading id="first-launch-mic">Play a video or music</Heading>
                            <Hint>
                                {platform === 'macos'
                                    ? 'Protocol listens to the computer for a few seconds.'
                                    : 'The ring moves when Protocol hears the computer.'}
                            </Hint>
                        </Prompt>
                    ) : (
                        <Prompt key="mic" {...swap}>
                            <Heading id="first-launch-mic">Say something</Heading>
                            <Hint>The ring moves when Protocol hears you.</Hint>
                        </Prompt>
                    )}
                </AnimatePresence>
                <Chips>
                    <Menu
                        align="start"
                        trigger={(
                            <Button size="sm" aria-label={`Microphone: ${mic ?? 'System default'}. Change`}>
                                <MicrophoneIcon size={12}/>
                                <ChipText>{mic ?? 'System default'}</ChipText>
                                <CaretDownIcon size={10}/>
                            </Button>
                        )}
                    >
                        <MenuRadioGroup
                            value={storedMic ?? SYSTEM_DEFAULT}
                            onValueChange={(value) => update.mutate({preferred_mic_device: value === SYSTEM_DEFAULT ? null : value})}
                        >
                            <MenuRadioItem value={SYSTEM_DEFAULT}>System default</MenuRadioItem>
                            {inputs.map((device) => (
                                <MenuRadioItem key={device.name} value={deviceValue(device)}>{device.name}</MenuRadioItem>
                            ))}
                        </MenuRadioGroup>
                    </Menu>
                    <Button size="sm" pending={listening} onClick={start}>
                        <SpeakerHighIcon size={12}/>
                        Test computer audio
                    </Button>
                </Chips>
                <AnimatePresence mode="wait" initial={false}>{note}</AnimatePresence>
            </Body>
        </Card>
    )
}
