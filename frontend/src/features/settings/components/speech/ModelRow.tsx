import {type ReactNode, useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {
    cancelModelUpdate,
    catalogStatusQuery,
    type CatalogEngine,
    modelUpdateState,
    startModelUpdate,
    updatePhaseLine,
} from '@/api/modelCatalog'
import {downloadKey, type DownloadState, modelState, type ModelState, type SpeechModelStatus} from '@/api/models'
import {Button} from '@/components/ui/Button'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {SettingsRow} from '@/components/ui/SettingsRow'
import {StatusLine, type Status} from '@/components/ui/StatusLine'
import {toast} from '@/components/ui/toastStore'
import {formatModelSize, withSize} from '@/lib/sizes'
import {isCorrupted} from '../../hooks/useSpeechModels'
import {RowControls, RowValue, Warning} from '../styles'
import {RemoveSheet} from './RemoveSheet'

export interface ModelRowProps {
    /** "Parakeet Lightning", "Whisper Large V3 Turbo". */
    name: string
    /** The download it has in `downloadsQuery`, by its engine. */
    engine: 'parakeet' | 'whisper' | 'intelGpu'
    model: {name: string, status?: SpeechModelStatus, size_bytes?: number | null}
    /** What it is used for now ("In use during meetings"), shown strong while installed. */
    use?: string | null
    /** The facts shown while nothing happens to it. */
    description: string
    downloads: Record<string, DownloadState>
    /** Its state instead of the one its status and download give (the Intel GPU version's). */
    state?: ModelState
    onDownload?: () => void
    onCancel?: () => void
    onRemove?: () => Promise<unknown>
    /** What removing it frees or changes, for the sheet. */
    removeDetail?: string
    /** Its updates, when the catalog lists it (`model_update_start`). */
    catalog?: {engine: CatalogEngine, id: string}
    /** Notices under it: a device that did not start, a running Intel download. */
    children?: ReactNode
}

/**
 * One speech model on Settings › Speech models: installed (and what for),
 * downloading below 100 % until native has verified it, failed with Retry,
 * damaged with Download again, or missing with its size. An installed
 * model the catalog has a newer revision of offers its update.
 */
export function ModelRow({name, engine, model, use, description, downloads, state, onDownload, onCancel, onRemove, removeDetail, catalog, children}: ModelRowProps) {
    const [removing, setRemoving] = useState(false)
    const shown = state ?? modelState(model.status, downloads[downloadKey(engine, model.name)])
    const damaged = shown.kind === 'missing' && isCorrupted(model.status)
    const size = formatModelSize(model.size_bytes)

    let status: Status | null = null
    if (shown.kind === 'downloading') status = {key: 'downloading', text: 'Downloading', value: `${Math.floor(shown.progress)}%`}
    if (shown.kind === 'activating') status = {key: 'activating', text: 'Turning it on for after meetings', busy: true}

    let control: ReactNode = null
    if (shown.kind === 'ready') {
        control = (
            <RowControls>
                <RowValue $strong={!!use}>{use ? 'In use' : 'Installed'}</RowValue>
                {onRemove && <Button size="sm" variant="ghost" aria-label={`Remove ${name}`} onClick={() => setRemoving(true)}>Remove</Button>}
            </RowControls>
        )
    } else if (shown.kind === 'downloading') {
        control = onCancel && <Button size="sm" variant="ghost" aria-label={`Cancel downloading ${name}`} onClick={onCancel}>Cancel</Button>
    } else if (shown.kind === 'failed') {
        control = onDownload && <Button size="sm" aria-label={`Retry downloading ${name}`} onClick={onDownload}>Retry</Button>
    } else if (shown.kind === 'missing') {
        control = onDownload && (
            <Button size="sm" aria-label={`${damaged ? 'Download again' : 'Download'} ${name}`} onClick={onDownload}>
                {withSize(damaged ? 'Download again' : 'Download', model.size_bytes)}
            </Button>
        )
    }

    return (
        <SettingsRow
            label={name}
            description={status ? <StatusLine status={status}/> : shown.kind === 'ready' && use ? use : damaged ? 'The copy on disk is damaged' : description}
            control={control}
        >
            {shown.kind === 'downloading' && <ProgressBar label={`Downloading ${name}`} value={shown.progress}/>}
            {shown.kind === 'failed' && <Warning role="alert">{shown.error}</Warning>}
            {shown.kind === 'ready' && catalog && <UpdateNotice name={name} {...catalog}/>}
            {children}
            {onRemove && (
                <RemoveSheet
                    open={removing}
                    onOpenChange={setRemoving}
                    name={name}
                    detail={removeDetail ?? (size ? `This frees ${size}.` : undefined)}
                    onRemove={onRemove}
                />
            )}
        </SettingsRow>
    )
}

const run = (action: () => Promise<unknown>) =>
    void action().catch((error) => toast.error('The model update didn’t start', {description: errorMessage(error)}))

/** An installed model's update: offered, running, failed, or a check that could not reach it. */
function UpdateNotice({name, engine, id}: {name: string, engine: CatalogEngine, id: string}) {
    const catalog = useQuery({...catalogStatusQuery, retry: false}).data
    const {operation, update, failure, checkFailure} = modelUpdateState(catalog, engine, id)
    if (operation) {
        const percent = operation.totalBytes > 0 ? (operation.doneBytes / operation.totalBytes) * 100 : 0
        const downloading = operation.phase === 'downloading'
        return (
            <>
                <RowControls>
                    <StatusLine status={{
                        key: operation.phase,
                        text: updatePhaseLine(operation),
                        value: downloading ? `${Math.floor(percent)}%` : undefined,
                        busy: !downloading && operation.phase !== 'waiting',
                    }}/>
                    {operation.phase !== 'installing' && (
                        <Button size="sm" variant="ghost" aria-label={`Cancel updating ${name}`} onClick={() => run(() => cancelModelUpdate(engine, id))}>
                            Cancel
                        </Button>
                    )}
                </RowControls>
                {downloading && <ProgressBar label={`Updating ${name}`} value={percent}/>}
            </>
        )
    }
    if (!update && !failure && !checkFailure) return null
    return (
        <RowControls>
            {failure ? <Warning role="alert">{`The update failed: ${failure.message}`}</Warning>
                : update ? <RowValue>{withSize('Update available', update.downloadBytes)}</RowValue>
                    : <RowValue>{`Couldn’t check for an update: ${checkFailure?.message}`}</RowValue>}
            {update && (
                <Button size="sm" aria-label={`Update ${name}`} onClick={() => run(() => startModelUpdate(engine, id))}>
                    {failure ? 'Try again' : 'Update'}
                </Button>
            )}
        </RowControls>
    )
}
