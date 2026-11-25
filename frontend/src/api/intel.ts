/**
 * Intel hardware for the speech models (Windows): Whisper's Intel GPU
 * version (an OpenVINO "companion" of a ggml model, #79) and Parakeet on the
 * Intel NPU (#66), both run by Intel's libraries (OpenVINO GenAI), which
 * download per computer. Types mirror `availability()` in
 * whisper_engine/openvino/mod.rs, `CompanionStatus` in
 * model_catalog/openvino.rs and `ParakeetNpuStatus` in
 * parakeet_engine/npu/state.rs.
 *
 * Every command but `get_openvino_availability` is registered on Windows
 * only; elsewhere it rejects, which reads as "nothing there" (the queries
 * answer null or `NPU_ABSENT`). The device words the UI uses are "Intel
 * GPU", "Intel NPU" and "the processor"; native texts name OpenVINO, which
 * the UI never does (`intelError`).
 *
 * What must outlive the WebView is native: `openvino_download` with
 * `choose` makes the Intel GPU version the after-meeting model when it
 * ends, and the NPU prepares itself once Intel's libraries are there.
 */
import {queryOptions} from '@tanstack/react-query'
import {safely, storedValue} from '@/lib/storage'
import {command, errorMessage} from './core'
import type {NativeEvent} from './events'
import {PARAKEET_MODEL, POST_CALL_WHISPER_MODEL} from './models'

/** `get_openvino_availability`. Outside Windows native answers `{available: false, …}`, without `offer`. */
export interface OpenVinoAvailability {
    /** Offer the download: the GPU whisper.cpp uses is an Intel GPU. */
    offer?: boolean
    gpu?: string | null
    reason: string | null
    /** With the libraries installed: the device Whisper runs on… */
    device: string | null
    /** …or why it cannot run Whisper here after all. */
    mismatch?: string | null
}

/** Intel's libraries as `openvino_status` reports them. */
export interface RuntimeStatus {
    name: string
    /** The version a download installs. */
    version: string
    license: {name: string, url: string}
    source: string
    downloadSize: number
    installedSize: number
    /** The installed version that runs, if any. */
    installed: string | null
    /** Installed while this run uses another: used after a restart. */
    afterRestart: string | null
    /** Loaded by this run but needed by nothing: the next start removes it. */
    removedAtRestart: string | null
}

/** `openvino_status`: the Intel GPU version of a Whisper model, null for a model without one. */
export interface CompanionStatus {
    id: string
    name: string
    description: string
    repo: string
    companionOf: string[]
    size: number | null
    companionInstalled: boolean
    runtime: RuntimeStatus | null
    /** The model and the libraries are both installed. */
    installed: boolean
    /** What Download fetches now. */
    downloadSize: number | null
    /** Why this version of Protocol cannot install the libraries. */
    refused: string | null
    /** A running download's percent. */
    downloading: number | null
    progress: {done: number, total: number} | null
    /** Off because Protocol closed inside it; `openvino_retry` turns it on. */
    stopped: string | null
    /** Remove deletes the libraries too: nothing else needs them. */
    removesRuntime: boolean
}

export type NpuState = 'absent' | 'needs_runtime' | 'needs_model' | 'waiting' | 'preparing' | 'ready' | 'failed'

export interface ParakeetNpuStatus {
    /** An Intel NPU exists; false only for `absent`. */
    present: boolean
    state: NpuState
    /** The loaded Parakeet model uses the NPU right now. */
    active: boolean
    /** For the log only; never shown. */
    reason: string | null
}

export const NPU_ABSENT: ParakeetNpuStatus = {present: false, state: 'absent', active: false, reason: null}

/** The id `openvino_cancel` takes for Intel's libraries alone (model_catalog/runtime.rs). */
export const INTEL_LIBRARIES_ID = 'openvino-genai'

/** The Parakeet model the NPU runs (#66). */
export const NPU_PARAKEET = PARAKEET_MODEL

/**
 * The Whisper model whose Intel GPU version the app offers: the catalog's
 * recommended copy, which the version stands in for and falls back to.
 */
export const GPU_VERSION_OF = POST_CALL_WHISPER_MODEL

// --- Commands ----------------------------------------------------------------

export const getOpenVinoAvailability = () => command<OpenVinoAvailability>('get_openvino_availability')

export const getCompanionStatus = (whisperModel: string = GPU_VERSION_OF) =>
    command<CompanionStatus | null>('openvino_status', {whisperModel})

export const getNpuStatus = () => command<ParakeetNpuStatus>('parakeet_npu_status')

/**
 * Downloads the Intel GPU version with Intel's libraries and resolves once
 * installed. With `choose` native saves it as the after-meeting model before
 * it resolves (first launch, Switch); without, it only installs (an update
 * of the libraries). Rejects with `INTEL_CANCELLED` after a cancel.
 */
export const downloadGpuVersion = (id: string, {choose}: {choose: boolean}) => command<null>('openvino_download', {id, choose})

/** Intel's libraries alone, for the NPU. Rejects with `INTEL_CANCELLED` after a cancel. */
export const downloadIntelLibraries = () => command<null>('openvino_runtime_download')

/** Cancels the download of `id`: a companion's id, or `INTEL_LIBRARIES_ID`. */
export const cancelIntelDownload = (id: string) => command<null>('openvino_cancel', {id})

/** Turns the Intel GPU version on again after a crash stopped it. */
export const retryIntelGpu = () => command<null>('openvino_retry')

/** Prepares Parakeet for the NPU again after it failed. */
export const retryNpu = () => command<ParakeetNpuStatus>('parakeet_npu_retry')

/** Whether the Compressed copy goes after the Intel GPU version's first meeting (speech_choice.rs). */
export const getCopyRetires = () => command<boolean>('speech_choice_copy_retires')

/** Removes the Intel GPU version; native puts the regular copy back in its place. Refused while transcribing. */
export const removeGpuVersion = (id: string) => command<null>('speech_choice_remove_gpu_version', {id})

/** The native messages of a cancelled Intel download and of a second call. */
export const INTEL_CANCELLED = 'The download was cancelled'
export const isIntelCancelled = (error: unknown) => errorMessage(error) === INTEL_CANCELLED

// --- Events ------------------------------------------------------------------

/** Something about the Intel GPU version or the libraries changed; read `openvino_status` again. */
export const OPENVINO_COMPANION_CHANGED_EVENT = 'openvino-companion-changed' as NativeEvent<null>
/** Bytes of Intel's libraries, during their download alone or as part of the Intel GPU version's. */
export const OPENVINO_RUNTIME_PROGRESS_EVENT = 'openvino-runtime-progress' as NativeEvent<{done: number, total: number}>
/** The NPU's whole status, on every change. */
export const NPU_STATUS_EVENT = 'parakeet-npu-status' as NativeEvent<ParakeetNpuStatus>

// --- Queries -----------------------------------------------------------------

export const intelKeys = {
    all: ['intel'] as const,
    availability: () => [...intelKeys.all, 'availability'] as const,
    companion: () => [...intelKeys.all, 'companion'] as const,
    npu: () => [...intelKeys.all, 'npu'] as const,
    copyRetires: () => [...intelKeys.all, 'copyRetires'] as const,
}

/** Read again on `openvino-companion-changed`, which `useModelDownloadSync` hears. */
export const openVinoAvailabilityQuery = queryOptions({
    queryKey: intelKeys.availability(),
    queryFn: () => getOpenVinoAvailability().catch((): OpenVinoAvailability => ({reason: null, device: null})),
    staleTime: Infinity,
})

/** Null outside Windows, and for a model without an Intel GPU version. */
export const companionQuery = queryOptions({
    queryKey: intelKeys.companion(),
    queryFn: () => getCompanionStatus().catch(() => null),
    staleTime: Infinity,
})

/** `parakeet-npu-status` writes it; `NPU_ABSENT` outside Windows. */
export const npuQuery = queryOptions({
    queryKey: intelKeys.npu(),
    queryFn: () => getNpuStatus().catch(() => NPU_ABSENT),
    staleTime: Infinity,
})

export const copyRetiresQuery = queryOptions({
    queryKey: intelKeys.copyRetires(),
    queryFn: () => getCopyRetires().catch(() => false),
})

// --- What the screens decide ---------------------------------------------------

/** The Intel GPU version can run here: the GPU is an Intel GPU and this build can install its libraries. */
export function gpuOffered(availability: OpenVinoAvailability | null | undefined, companion: CompanionStatus | null | undefined): companion is CompanionStatus {
    return !!availability?.offer && !!companion && !companion.refused
}

/**
 * The NPU wants Intel's libraries: it is there, waits for them, and runs
 * Parakeet v3, which must be installed (#66 keeps the libraries only while
 * it is, so libraries fetched without it would go at the next start).
 */
export const npuWantsLibraries = (npu: ParakeetNpuStatus, parakeetInstalled: boolean) =>
    npu.present && npu.state === 'needs_runtime' && parakeetInstalled

/** The NPU states in which Parakeet on the GPU (Labs) does nothing: the NPU wins. */
export const npuOwnsParakeet = (npu: ParakeetNpuStatus) => npu.state === 'preparing' || npu.state === 'ready'

/** Why the installed Intel GPU version is not running, or null. */
export function gpuFallback(companion: CompanionStatus | null | undefined, availability: OpenVinoAvailability | null | undefined, fallbackReason: string | null = null): string | null {
    if (!companion?.installed) return null
    return companion.stopped ?? fallbackReason ?? availability?.mismatch ?? null
}

/** A native error of the Intel downloads in the UI's words; others pass unchanged. */
export function intelError(error: unknown): string {
    const raw = errorMessage(error)
    const space = /^Not enough free space for [^:]+: (.+?)\.?$/.exec(raw)
    if (space) return `Not enough free space: ${space[1]}.`
    if (/no OpenVINO runtime/i.test(raw)) return "Intel's libraries for this computer aren't available yet."
    if (/cannot run/i.test(raw) && /OpenVINO/i.test(raw)) {
        return "This version of Protocol can't use the Intel libraries on offer. Update Protocol to use them."
    }
    if (/openvino|genai|runtime|plugin|directml|onnx/i.test(raw)) return "Something went wrong with Intel's libraries. Try again later."
    return raw
}

// --- The offer and "Not now" ---------------------------------------------------

export type IntelDevice = 'Intel GPU' | 'Intel NPU'

export interface IntelOffer {
    devices: IntelDevice[]
    title: string
    description: string
    /** Switch downloads the Intel GPU version (with the libraries), else the libraries alone. */
    gpu: boolean
}

/**
 * The offer at the top of Settings › AI: after an update (some speech model
 * is installed), an Intel GPU without the Intel GPU version, or an Intel NPU
 * without Intel's libraries. Not now hides it until a device it did not
 * offer then becomes one to offer.
 */
export function offerFor({installedAny, availability, companion, npu, parakeetInstalled, librariesDownloading, dismissed}: {
    installedAny: boolean
    availability: OpenVinoAvailability | null | undefined
    companion: CompanionStatus | null | undefined
    npu: ParakeetNpuStatus
    parakeetInstalled: boolean
    librariesDownloading: boolean
    dismissed: readonly IntelDevice[]
}): IntelOffer | null {
    if (!installedAny) return null
    const gpu = gpuOffered(availability, companion) && !companion.installed && companion.downloading === null
    const npuWanted = npuWantsLibraries(npu, parakeetInstalled) && !librariesDownloading
    const devices: IntelDevice[] = [...(gpu ? ['Intel GPU' as const] : []), ...(npuWanted ? ['Intel NPU' as const] : [])]
    if (devices.length === 0 || devices.every((device) => dismissed.includes(device))) return null
    if (gpu && npuWanted) {
        return {
            devices,
            gpu,
            title: 'Protocol can use your Intel GPU and NPU',
            description: 'A version of Whisper made for the GPU writes the after-meeting transcript faster, and live text takes less power.',
        }
    }
    return gpu
        ? {devices, gpu, title: 'Protocol can use your Intel GPU', description: 'A version of Whisper made for it writes the after-meeting transcript faster.'}
        : {devices, gpu, title: 'Protocol can use your Intel NPU', description: "Live text takes less power once Intel's libraries are downloaded."}
}

export const INTEL_OFFER_DISMISSED_KEY = 'meetily-intel-offer-dismissed'

function readDismissed(stored: string | null): IntelDevice[] {
    const value: unknown = stored ? safely(() => JSON.parse(stored)) : null
    return Array.isArray(value) ? value.filter((device): device is IntelDevice => device === 'Intel GPU' || device === 'Intel NPU') : []
}

/** The devices whose offer got "Not now", in the old format: a bare JSON array, the key removed when empty. */
export const useIntelOfferDismissedStore = storedValue(
    INTEL_OFFER_DISMISSED_KEY,
    readDismissed,
    (dismissed) => (dismissed.length ? JSON.stringify(dismissed) : null),
)

/** "Not now" for these devices, keeping the ones dismissed before. */
export function dismissIntelOffer(devices: readonly IntelDevice[]) {
    const {value, set} = useIntelOfferDismissedStore.getState()
    set([...new Set([...value, ...devices])])
}
