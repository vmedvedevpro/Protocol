import {type ReactNode, useState} from 'react'
import {CaretDownIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {
    activeEngine,
    cancelNemotronDownload,
    DIARIZATION_DOWNLOAD_CANCELLED,
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
import {SettingsGroup, SettingsRadioGroup, SettingsRadioRow, SettingsRow} from '@/components/ui/SettingsRow'
import {focusRing} from '@/components/ui/styles'
import {toast} from '@/components/ui/toastStore'
import {formatModelSize} from '@/lib/sizes'
import {useDebouncedSave} from '../../hooks/useDebouncedSave'
import {Disclosure, Range, SliderLine, SliderValue, Warning} from '../styles'
import {ModelRow} from '../ModelRow'

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

/** What Nemotron is for, which its name cannot say. */
const BETTER = 'Better when people talk over each other'

const CC_BY_4_0 = 'https://creativecommons.org/licenses/by/4.0/'

function Credit({href, children}: {href: string, children: ReactNode}) {
    return <Link type="button" onClick={() => openLink(href)}>{children}</Link>
}

function ThresholdRow({threshold}: {threshold: number}) {
    const save = useMutation(setNemotronThresholdMutation())
    const {draft, change} = useDebouncedSave((value: number) => save.mutate(value, {
        onError: (error) => toast.error('Couldn’t save the threshold', {description: errorMessage(error)}),
    }))
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
                    onChange={(event) => change(Number(event.target.value))}
                />
                <SliderValue>{value.toFixed(2)}</SliderValue>
            </SliderLine>
        </SettingsRow>
    )
}

/**
 * Who said what: Pyannote, built in, or NVIDIA Nemotron, installed on
 * demand. Nemotron is a choice only once it is installed, so choosing never
 * downloads anything (owner decision 2026-11-25); until then its `ModelRow`
 * offers Install with its size, its progress and Cancel. Native chooses
 * Nemotron once the download is verified, as the user asked for it; a
 * removal goes back to Pyannote first (`uninstall_optional_model`).
 */
export function SpeakersGroup() {
    const status = useQuery(diarizationStatusQuery)
    const downloads = useQuery(downloadsQuery).data
    const choose = useMutation(setDiarizationEngineMutation())
    const [credits, setCredits] = useState(false)

    const engine = activeEngine(status.data)
    const installed = !!status.data?.nemotron_available
    const size = status.data?.nemotron_download_size

    const getNemotron = () => {
        void downloadNemotron()
            .then(() => toast.success('Speakers are now identified with NVIDIA Nemotron'))
            .catch((error) => {
                const message = errorMessage(error)
                if (message === DIARIZATION_DOWNLOAD_CANCELLED) return
                toast.error(message.startsWith('Model downloaded') ? 'Nemotron installed, but couldn’t be turned on' : 'Nemotron didn’t install', {description: message})
            })
    }
    const cancel = () => void cancelNemotronDownload().catch((error) => toast.error('Couldn’t cancel the download', {description: errorMessage(error)}))
    const pick = (next: SpeakerEngine) => {
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
                <SettingsRadioRow value="pyannote" label="Pyannote" badge="Built in"/>
                {installed && <SettingsRadioRow value="nemotron" label="NVIDIA Nemotron" description={BETTER}/>}
            </SettingsRadioGroup>
            <SettingsGroup>
                <ModelRow
                    name="NVIDIA Nemotron"
                    engine="nemotron"
                    model={{name: NEMOTRON, status: installed ? 'Available' : 'Missing', size_bytes: size}}
                    use={engine === 'nemotron' && installed ? 'Identifies speakers in new meetings' : null}
                    description={installed ? '' : BETTER}
                    downloads={downloads}
                    onDownload={getNemotron}
                    onCancel={cancel}
                    onRemove={() => uninstallOptionalModel('nemotron').catch((error) =>
                        toast.error('Couldn’t remove NVIDIA Nemotron', {description: errorMessage(error)}))}
                    removeDetail={`${size ? `This frees about ${formatModelSize(size)}. ` : ''}Pyannote identifies speakers from then on.`}
                >
                    {engine === 'nemotron' && !installed && downloads[downloadKey('nemotron', NEMOTRON)]?.state !== 'downloading' && (
                        <Warning role="alert">Nemotron is chosen but not downloaded, so speakers can’t be identified. Install it, or choose Pyannote</Warning>
                    )}
                </ModelRow>
                {engine === 'nemotron' && installed && <ThresholdRow threshold={status.data?.nemotron_threshold ?? THRESHOLD.default}/>}
                <SettingsRow
                    label="Model files and credits"
                    control={(
                        <Button size="sm" onClick={() => void openSpeakerModelFolder().catch((error) => toast.error('Couldn’t open the folder', {description: errorMessage(error)}))}>
                            Open folder
                        </Button>
                    )}
                >
                    <div>
                        <Disclosure type="button" aria-expanded={credits} onClick={() => setCredits(!credits)}>
                            Credits
                            <CaretDownIcon size={11} aria-hidden/>
                        </Disclosure>
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
        </>
    )
}
