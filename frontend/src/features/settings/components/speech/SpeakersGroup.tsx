import {type ReactNode, useEffect, useEffectEvent, useRef, useState} from 'react'
import {CaretDownIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {
    activeEngine,
    diarizationStatusQuery,
    downloadNemotron,
    NEMOTRON,
    openSpeakerModelFolder,
    setDiarizationEngineMutation,
    setNemotronThresholdMutation,
    type SpeakerEngine,
    THRESHOLD,
} from '@/api/diarization'
import {openLink} from '@/api/links'
import {downloadKey, downloadsQuery, uninstallOptionalModel} from '@/api/models'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {SettingsGroup, SettingsRadioGroup, SettingsRadioRow, SettingsRow} from '@/components/ui/SettingsRow'
import {StatusLine} from '@/components/ui/StatusLine'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {toast} from '@/components/ui/toastStore'
import {formatModelSize, withSize} from '@/lib/sizes'
import {Range, SliderLine, SliderValue, Warning} from '../styles'
import {facts} from './modelText'
import {RemoveSheet} from './RemoveSheet'

const CreditsButton = styled.button`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    padding: 0;
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.muted};
    font: inherit;
    ${({theme}) => theme.text.small};
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }

    > svg {
        transition: transform ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    &[aria-expanded='true'] > svg {
        transform: rotate(180deg);
    }
`

const Credits = styled.p`
    padding-top: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
    overflow-wrap: anywhere;
`

const Link = styled.button`
    padding: 0;
    border: 0;
    background: transparent;
    color: ${({theme}) => theme.colors.text};
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
    ${focusRing};
`

const CC_BY_4_0 = 'https://creativecommons.org/licenses/by/4.0/'

function Credit({href, children}: {href: string, children: ReactNode}) {
    return <Link type="button" onClick={() => openLink(href)}>{children}</Link>
}

// A drag saves once it rests this long, as the volumes do.
const THRESHOLD_SAVE_MS = 250

function ThresholdRow({threshold}: {threshold: number}) {
    const save = useMutation(setNemotronThresholdMutation())
    const [draft, setDraft] = useState<number | null>(null)
    const pending = useRef<number | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    const flush = () => {
        clearTimeout(timer.current)
        if (pending.current === null) return
        save.mutate(pending.current, {onError: (error) => toast.error('Couldn’t save the threshold', {description: errorMessage(error)})})
        pending.current = null
    }
    const flushOnLeave = useEffectEvent(flush)
    useEffect(() => () => flushOnLeave(), [])
    const value = draft ?? threshold

    return (
        <SettingsRow label="Speech threshold" description="How sure Nemotron must be that someone is talking. Raise it if noise turns into a speaker">
            <SliderLine>
                <Range
                    type="range"
                    aria-label="Speech threshold"
                    aria-valuetext={value.toFixed(2)}
                    min={THRESHOLD.min}
                    max={THRESHOLD.max}
                    step={THRESHOLD.step}
                    value={value}
                    onChange={(event) => {
                        const next = Number(event.target.value)
                        setDraft(next)
                        pending.current = next
                        clearTimeout(timer.current)
                        timer.current = setTimeout(() => {
                            flush()
                            setDraft(null)
                        }, THRESHOLD_SAVE_MS)
                    }}
                />
                <SliderValue>{value.toFixed(2)}</SliderValue>
            </SliderLine>
        </SettingsRow>
    )
}

/**
 * Who said what: Pyannote, built in, or NVIDIA Nemotron, downloaded on
 * demand. Choosing Nemotron before it is installed downloads it, and native
 * chooses it once the download is verified; until then Pyannote stays.
 * Removal goes back to Pyannote first (`uninstall_optional_model`).
 */
export function SpeakersGroup() {
    const status = useQuery(diarizationStatusQuery)
    const download = useQuery(downloadsQuery).data[downloadKey('nemotron', NEMOTRON)]
    const choose = useMutation(setDiarizationEngineMutation())
    const [removing, setRemoving] = useState(false)
    const [credits, setCredits] = useState(false)

    const engine = activeEngine(status.data)
    const installed = !!status.data?.nemotron_available
    const size = status.data?.nemotron_download_size
    const downloading = download?.state === 'downloading'

    const getNemotron = () => {
        void downloadNemotron()
            .then(() => toast.success('Speakers are now identified with NVIDIA Nemotron'))
            .catch((error) => {
                const message = errorMessage(error)
                toast.error(message.startsWith('Model downloaded') ? 'Nemotron downloaded, but couldn’t be turned on' : 'Nemotron didn’t download', {description: message})
            })
    }
    const pick = (next: SpeakerEngine) => {
        if (next === 'nemotron' && !installed) return getNemotron()
        choose.mutate(next, {onError: (error) => toast.error('Couldn’t change the speaker engine', {description: errorMessage(error)})})
    }

    return (
        <>
            <SettingsRadioGroup<SpeakerEngine>
                title="Speakers"
                value={status.data ? engine : undefined}
                onValueChange={pick}
                disabled={!status.data}
            >
                <SettingsRadioRow value="pyannote" label="Pyannote" description="Built in. Ready right away" badge="Built in"/>
                <SettingsRadioRow
                    value="nemotron"
                    label="NVIDIA Nemotron"
                    description={installed ? 'Better when people talk over each other' : 'Better when people talk over each other. Choosing it downloads it'}
                    badge={installed ? 'Installed' : undefined}
                />
            </SettingsRadioGroup>
            <SettingsGroup>
                <SettingsRow
                    label="NVIDIA Nemotron"
                    description={downloading
                        ? <StatusLine status={{key: 'nemotron', text: 'Downloading', value: `${Math.floor(download.progress)}%`}}/>
                        : installed ? 'Installed' : facts('Downloaded when you choose it', formatModelSize(size))}
                    control={downloading ? null : installed ? (
                        <Button size="sm" variant="ghost" aria-label="Remove NVIDIA Nemotron" onClick={() => setRemoving(true)}>Remove</Button>
                    ) : (
                        <Button size="sm" aria-label="Download NVIDIA Nemotron" onClick={getNemotron}>
                            {withSize(download?.state === 'failed' ? 'Retry' : 'Download', size)}
                        </Button>
                    )}
                >
                    {downloading && <ProgressBar label="Downloading NVIDIA Nemotron" value={download.progress}/>}
                    {download?.state === 'failed' && <Warning role="alert">{download.error}</Warning>}
                    {engine === 'nemotron' && !installed && !downloading && (
                        <Warning role="alert">Nemotron is chosen but not downloaded, so speakers can’t be identified. Download it, or choose Pyannote</Warning>
                    )}
                </SettingsRow>
                {engine === 'nemotron' && installed && <ThresholdRow threshold={status.data?.nemotron_threshold ?? THRESHOLD.default}/>}
                <SettingsRow
                    label="Model files and credits"
                    description="Where speaker models are kept"
                    control={(
                        <Button size="sm" onClick={() => void openSpeakerModelFolder().catch((error) => toast.error('Couldn’t open the folder', {description: errorMessage(error)}))}>
                            Open folder
                        </Button>
                    )}
                >
                    <div>
                        <CreditsButton type="button" aria-expanded={credits} onClick={() => setCredits(!credits)}>
                            Credits
                            <CaretDownIcon size={12} aria-hidden/>
                        </CreditsButton>
                        <Collapse open={credits}>
                            <Credits>
                                {status.data?.model_dir && <>Folder: {status.data.model_dir}. </>}
                                Models: <Credit href="https://huggingface.co/pyannote/segmentation-3.0">pyannote segmentation-3.0</Credit> by CNRS
                                (<Credit href="https://huggingface.co/pyannote/segmentation-3.0/blob/main/LICENSE">MIT</Credit>) ·{' '}
                                <Credit href="https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM">WeSpeaker ResNet34-LM</Credit> by the
                                WeSpeaker project (<Credit href={CC_BY_4_0}>CC BY 4.0</Credit>) · VBx x-vector transform by BUT Speech@FIT, from{' '}
                                <Credit href="https://huggingface.co/pyannote-community/speaker-diarization-community-1">pyannote community-1</Credit>
                                {' '}(<Credit href={CC_BY_4_0}>CC BY 4.0</Credit>). NVIDIA Nemotron-3 Diarization (Sortformer v3) and the NeMo
                                128 mel-spectrogram model are credited to NVIDIA Corporation; their license downloads with them.
                            </Credits>
                        </Collapse>
                    </div>
                </SettingsRow>
            </SettingsGroup>
            <RemoveSheet
                open={removing}
                onOpenChange={setRemoving}
                name="NVIDIA Nemotron"
                detail={`${size ? `This frees about ${formatModelSize(size)}. ` : ''}Pyannote identifies speakers from then on.`}
                onRemove={() => uninstallOptionalModel('nemotron').catch((error) =>
                    toast.error('Couldn’t remove NVIDIA Nemotron', {description: errorMessage(error)}))}
            />
        </>
    )
}
