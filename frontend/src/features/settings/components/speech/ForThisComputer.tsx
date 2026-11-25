import {useQuery, useQueryClient} from '@tanstack/react-query'
import {
    cancelIntelDownload,
    companionQuery,
    copyRetiresQuery,
    downloadGpuVersion,
    downloadIntelLibraries,
    gpuFallback,
    gpuOffered,
    INTEL_LIBRARIES_ID,
    intelError,
    isIntelCancelled,
    npuQuery,
    npuWantsLibraries,
    openVinoAvailabilityQuery,
    removeGpuVersion,
    retryIntelGpu,
    retryNpu,
} from '@/api/intel'
import {gpuFallbackReason, localStackKeys, localStackQuery, retryWhisperGpu} from '@/api/localStack'
import {trackIntelDownload} from '@/api/modelDownloadSync'
import {PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from '@/api/models'
import {Button} from '@/components/ui/Button'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {StatusLine} from '@/components/ui/StatusLine'
import {toast} from '@/components/ui/toastStore'
import {formatModelSize} from '@/lib/sizes'
import {speechModelLabel} from '@/lib/speechModels'
import {useModelUse, useSpeechModels} from '../../hooks/useSpeechModels'
import {RowControls, RowValue, Warning} from '../styles'
import {ModelRow} from '../ModelRow'
import {facts} from './modelText'

const quiet = (error: unknown) => {
    if (!isIntelCancelled(error)) console.warn('Intel download:', error)
}

/**
 * The pair picked for this computer (#88): Parakeet for live text and
 * Whisper Large V3 Turbo after meetings, each on the best device here. On an
 * Intel GPU, Whisper's Intel GPU version takes the Whisper row once
 * installed, and "Use your Intel GPU" offers it until then; on an Intel NPU
 * Parakeet says how it gets there. Every Intel download is native's; the
 * Intel GPU version becomes the after-meeting model natively (`choose`).
 */
export function ForThisComputer() {
    const queryClient = useQueryClient()
    const {parakeet, whisper, gpuVersion, downloads, download, cancel, remove, refresh} = useSpeechModels()
    const usageOf = useModelUse()
    const availability = useQuery(openVinoAvailabilityQuery).data
    const companion = useQuery(companionQuery).data
    const npu = useQuery(npuQuery).data
    const stack = useQuery(localStackQuery).data
    const copyRetires = useQuery(copyRetiresQuery).data

    const live = parakeet.find(({name}) => name === PARAKEET_MODEL)
    const copy = whisper.find(({name}) => name === POST_CALL_WHISPER_MODEL)
    const offered = gpuOffered(availability, companion) ? companion : null
    const gpuInstalled = !!offered?.installed && !!gpuVersion
    const fellBack = gpuInstalled ? gpuFallback(offered, availability, gpuFallbackReason(stack)) : null
    const npuOn = !!npu && (npu.state === 'ready' || npu.active)

    // A download of the Intel GPU version brings the libraries the NPU needs.
    const librariesWanted = !!npu && npuWantsLibraries(npu, live?.status === 'Available') && !(offered && !offered.installed)

    const switchToGpu = () => {
        if (!offered) return
        void trackIntelDownload(queryClient, 'intelGpu', offered.id, () => downloadGpuVersion(offered.id, {choose: true}))
            .then(() => toast.success('Whisper is ready for the Intel GPU', {description: 'Transcripts after meetings use it from the next one on.'}))
            .catch(quiet)
            .finally(refresh)
    }
    const getLibraries = () => {
        void trackIntelDownload(queryClient, 'intelLibraries', INTEL_LIBRARIES_ID, downloadIntelLibraries)
            .then(() => toast.success("Intel's libraries are installed", {description: 'Parakeet gets ready for the Intel NPU once, then runs on it.'}))
            .catch(quiet)
    }
    const cancelIntel = (id: string) => void cancelIntelDownload(id).catch(() => undefined)
    const retry = (action: () => Promise<unknown>) => () =>
        void action().catch((error) => toast.error('That didn’t work', {description: intelError(error)})).finally(refresh)
    // The GPU's devices are read once per process, so the retry waits for the next start.
    const retryGpu = () => void retryWhisperGpu()
        .then(() => toast.success('Whisper tries the graphics card again', {description: 'From the next start of Protocol on.'}))
        .catch((error) => toast.error('That didn’t work', {description: intelError(error)}))
        .finally(() => void queryClient.invalidateQueries({queryKey: localStackKeys.all}))

    const parakeetRow = live && (
        <ModelRow
            name="Parakeet"
            engine="parakeet"
            model={live}
            use={usageOf('parakeet', live.name)}
            description={facts(`During meetings · on ${npuOn ? 'the Intel NPU' : 'the processor'}`, formatModelSize(live.size_bytes))}
            downloads={downloads}
            onDownload={() => download(live)}
            onCancel={() => cancel(live)}
            onRemove={() => remove(live)}
        >
            {npu?.state === 'preparing' && <StatusLine status={{key: 'npu-preparing', text: 'Getting ready for the Intel NPU, once. Live text keeps working meanwhile', busy: true}}/>}
            {npu?.state === 'waiting' && <RowValue>Gets ready for the Intel NPU once the recording or transcription has finished</RowValue>}
            {npu?.present && npu.state === 'failed' && (
                <RowControls>
                    <Warning role="status">The Intel NPU didn’t start, so Parakeet runs on the processor</Warning>
                    <Button size="sm" variant="ghost" onClick={retry(retryNpu)}>Try again</Button>
                </RowControls>
            )}
        </ModelRow>
    )

    // Intel's libraries alone, for the NPU; the row goes once the NPU stops waiting for them.
    const librariesRow = librariesWanted && (
        <ModelRow
            name="Intel's libraries"
            engine="intelLibraries"
            model={{name: INTEL_LIBRARIES_ID, status: 'Missing', size_bytes: companion?.runtime?.downloadSize}}
            description="Parakeet runs on the Intel NPU once they are downloaded"
            downloads={downloads}
            onDownload={getLibraries}
            onCancel={() => cancelIntel(INTEL_LIBRARIES_ID)}
        />
    )

    const whisperRow = gpuInstalled && gpuVersion && offered ? (
        <ModelRow
            name={speechModelLabel('whisper', gpuVersion)}
            engine="whisper"
            model={gpuVersion}
            use={usageOf('whisper', gpuVersion.name)}
            description={facts('After meetings · on the Intel GPU', formatModelSize((offered.size ?? 0) + (offered.runtime?.installedSize ?? 0)))}
            downloads={downloads}
            onRemove={() => removeGpuVersion(offered.id)
                .catch((error) => toast.error('Couldn’t remove the Intel GPU version', {description: intelError(error)}))
                .finally(refresh)}
            removeDetail={`Whisper goes back to the regular copy${offered.removesRuntime ? ", and Intel's libraries are removed too" : ''}.`}
        >
            {fellBack && (
                <RowControls>
                    <Warning role="status">
                        {copy?.status === 'Available'
                            ? 'The Intel GPU version didn’t start, so Whisper uses the regular copy'
                            : 'The Intel GPU version didn’t start, and no regular copy is installed'}
                    </Warning>
                    <Button size="sm" variant="ghost" onClick={retry(retryIntelGpu)}>Try again</Button>
                </RowControls>
            )}
            {copyRetires && copy?.status === 'Available' && <RowValue>The regular copy stays until this one has transcribed a meeting</RowValue>}
        </ModelRow>
    ) : copy && (
        <ModelRow
            name={speechModelLabel('whisper', copy)}
            engine="whisper"
            model={copy}
            use={usageOf('whisper', copy.name)}
            description={facts('After meetings', formatModelSize(copy.size_bytes))}
            downloads={downloads}
            onDownload={() => download(copy, {activate: true})}
            onCancel={() => cancel(copy)}
            onRemove={() => remove(copy)}
            removeDetail={facts(formatModelSize(copy.size_bytes) && `This frees ${formatModelSize(copy.size_bytes)}`, 'Transcripts after meetings then use the live model') + '.'}
        />
    )

    // Linux: a row of its own, so it shows whichever Whisper row this computer has, or none.
    const gpuStoppedRow = stack?.whisper.gpuStopped && (
        <SettingsRow
            label="Graphics card"
            description={<Warning role="status" title={stack.whisper.gpuStopped}>It didn’t start last time, so Whisper runs on the processor</Warning>}
            control={<Button size="sm" variant="ghost" onClick={retryGpu}>Try again</Button>}
        />
    )

    return (
        <SettingsGroup title="For this computer">
            {parakeetRow}
            {whisperRow}
            {gpuStoppedRow}
            {librariesRow}
            {offered && !offered.installed && (
                <ModelRow
                    name="Whisper for the Intel GPU"
                    engine="intelGpu"
                    model={{name: offered.id, status: 'Missing', size_bytes: offered.downloadSize}}
                    description="A faster Whisper for this computer, used after meetings"
                    downloads={downloads}
                    onDownload={switchToGpu}
                    onCancel={() => cancelIntel(offered.id)}
                />
            )}
        </SettingsGroup>
    )
}
