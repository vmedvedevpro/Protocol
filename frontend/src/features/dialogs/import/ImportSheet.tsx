import {type FormEvent, useEffect, useState} from 'react'
import {CaretDownIcon, DownloadSimpleIcon, WaveformIcon, XIcon} from '@phosphor-icons/react'
import {type QueryClient, useQuery, useQueryClient} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled, {css} from 'styled-components'
import {
    AUDIO_FORMATS_TEXT,
    type AudioFileInfo,
    cancelImport,
    checkAudioFile,
    chooseAudioFile,
    IMPORT_COMPLETE_EVENT,
    IMPORT_ERROR_EVENT,
    IMPORT_PROGRESS_EVENT,
    type ImportResult,
    startImport,
} from '@/api/audioImport'
import {errorMessage} from '@/api/core'
import {useNativeEvent} from '@/api/events'
import {postCallControls} from '@/api/postCall'
import {folderKeys, foldersQuery, meetingKeys, saveMeetingSummaryLanguage, setMeetingFolder} from '@/api/meetings'
import {useMeetingLanguageStore, useSummaryLanguageStore} from '@/api/preferences'
import {Button, IconButton} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {Spinner} from '@/components/ui/Spinner'
import {colorTransition, focusRing} from '@/components/ui/styles'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'
import {DETECT_LANGUAGE, MEETING_LANGUAGES} from '@/lib/languages'
import {paths} from '@/lib/paths'
import {MOTION_OK} from '@/styles/motion'
import {parseSpeechModel} from '@/lib/speechModels'
import {useSpeechModels} from '../lib/useSpeechModels'
import {isRunning, resetImport, useImportState} from './importState'

const FORM_ID = 'import-recording'

// Folder ids are UUIDs; Radix's Select takes no empty value.
const NO_FOLDER = 'none'

const LANGUAGE_OPTIONS = MEETING_LANGUAGES.map(({code, label}) => ({value: code, label}))

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2.5]};
`

// The whole area is the picker's one button: a click, Enter or Space
// anywhere in it opens the picker, and a file dragged over the window lights
// it up (`$dragging`, from DropOverlay). Its edge is a field's (`fieldBorder`),
// and hover and drag fill it with `surface`, so it reads as a target on a
// sheet in both themes.
const Drop = styled.button<{ $dragging: boolean }>`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    width: 100%;
    margin: 0;
    padding: ${({theme}) => theme.space[4]} ${({theme}) => theme.space[3]};
    border: ${({theme}) => theme.sizes.radio.ring} dashed ${({theme}) => theme.colors.fieldBorder};
    border-radius: ${({theme}) => theme.radii.lg};
    background: transparent;
    font: inherit;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.text};
    text-align: center;
    cursor: pointer;
    ${colorTransition};
    ${focusRing};

    > svg {
        color: ${({theme}) => theme.colors.muted};
    }

    &:hover:not(:disabled) {
        border-color: ${({theme}) => theme.colors.muted};
        background: ${({theme}) => theme.colors.surface};
    }

    &:disabled {
        cursor: default;
    }

    ${({$dragging}) => $dragging && css`
        &, &:hover:not(:disabled) {
            border-color: ${({theme}) => theme.colors.text};
            background: ${({theme}) => theme.colors.surface};
        }

        > svg {
            color: ${({theme}) => theme.colors.text};
        }
    `};
`

// "Choose a file" drawn as a small secondary button inside the area; the
// area is the button, so this is only its look.
const ChooseLook = styled.span`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
    height: ${({theme}) => theme.sizes.control.sm};
    margin: ${({theme}) => theme.space[0.5]} 0;
    padding: 0 ${({theme}) => theme.space[2.5]};
    border: 1px solid ${({theme}) => theme.colors.fieldBorder};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.raised};
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.medium};
`

const Rejected = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
    text-align: center;
`

const Hint = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const File = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[2.5]};
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.surface};

    > svg {
        flex: none;
        color: ${({theme}) => theme.colors.muted};
    }
`

const FileText = styled.span`
    flex: 1;
    min-width: 0;
`

const FileName = styled.span`
    display: block;
    overflow: hidden;
    ${({theme}) => theme.text.body};
    white-space: nowrap;
    text-overflow: ellipsis;
`

const Field = styled.div`
    width: ${({theme}) => theme.sizes.popover.triggerMaxWidth};
    flex: none;
`

const Disclosure = styled.button`
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: ${({theme}) => theme.space[1.5]};
    height: ${({theme}) => theme.sizes.control.sm};
    margin: ${({theme}) => theme.space[0.5]} 0 0 -${({theme}) => theme.space[1.5]};
    padding: 0 ${({theme}) => theme.space[1.5]};
    border: 0;
    border-radius: ${({theme}) => theme.radii.sm};
    background: none;
    ${({theme}) => theme.text.label};
    font-weight: ${({theme}) => theme.fontWeights.regular};
    color: ${({theme}) => theme.colors.muted};
    cursor: pointer;
    ${focusRing};

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }

    /* The turned caret is the open state, so it shows under reduced motion too; only the turn animates. */
    &[aria-expanded='true'] svg {
        transform: rotate(180deg);
    }

    ${MOTION_OK} {
        svg {
            transition: transform ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
        }
    }
`

const Progress = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};
`

const ProgressLine = styled.div`
    display: flex;
    gap: ${({theme}) => theme.space[2]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};

    > span:first-child {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }
`

const Percent = styled.span`
    font-variant-numeric: tabular-nums;
`

const Failure = styled.p`
    margin: 0;
    ${({theme}) => theme.text.body};
    color: ${({theme}) => theme.colors.text};
    overflow-wrap: anywhere;
`

/** "38 min", "1 h 05 min", "under a minute". */
function fileLength(seconds: number): string {
    const minutes = Math.round(seconds / 60)
    if (minutes < 1) return 'under a minute'
    if (minutes < 60) return `${minutes} min`
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

/**
 * Import a recording: an audio or video file, chosen here or dropped on
 * the window, becomes a meeting. Title and folder are asked; the language
 * and the model, "for this import only", sit under Advanced options and
 * start from the meeting language and the after-meeting model. Native code
 * runs the import, one at a time; the sheet shows its progress, cannot be
 * dismissed meanwhile, and Stop asks native to cancel. When it ends the
 * meeting is filed and given the pinned summary language, and opens.
 */
export function ImportSheet() {
    const slot = useDialog()
    const request = slot.request?.kind === 'import' ? slot.request : null
    const open = slot.open && request !== null
    const client = useQueryClient()
    const navigate = useNavigate()
    const pinnedSummaryLanguage = useSummaryLanguageStore((state) => state.value)
    const phase = useImportState((state) => state.phase)
    const running = isRunning(phase)
    const [completeHeard, setCompleteHeard] = useState(false)

    // Heard here, whatever the sheet shows: DialogHost keeps the sheet
    // mounted while another dialog takes the slot, so an import the form no
    // longer follows is still filed, opened and handed to the post-call
    // steps.
    useNativeEvent(IMPORT_COMPLETE_EVENT, (result) => {
        void client.invalidateQueries({queryKey: meetingKeys.lists()})
        if (isRunning(useImportState.getState().phase)) {
            void finishImport(result, pinnedSummaryLanguage, client, (meetingId) => void navigate(paths.meeting(meetingId)))
        }
    }, {onListening: () => setCompleteHeard(true)})

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && !running && closeDialog('import')}
            title="Import a recording"
            description="Protocol transcribes it into a new meeting, as it does a recording."
            footer={(
                <>
                    {running ? (
                        <Button variant="ghost" pending={phase.step === 'cancelling'} onClick={() => void stopImport()}>Stop</Button>
                    ) : (
                        <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    )}
                    {phase.step === 'failed' ? (
                        <Button variant="filled" type="submit" form={FORM_ID}>Try again</Button>
                    ) : (
                        <Button variant="filled" type="submit" form={FORM_ID} pending={running} disabled={phase.step !== 'ready' && !running}>
                            Import
                        </Button>
                    )}
                </>
            )}
        >
            {request && <ImportForm key={request.seq} request={request} completeHeard={completeHeard}/>}
        </Sheet>
    )
}

/** Has native check a file, chosen in its picker or dropped; a cancelled picker keeps the file there was. */
async function checkFile(read: () => Promise<AudioFileInfo | null>) {
    const {phase, file} = useImportState.getState()
    if (isRunning(phase)) {
        toast.info('One recording imports at a time', {description: 'Drop it again when this import ends.'})
        return
    }
    useImportState.setState({phase: {step: 'checking'}, rejectedDrop: false})
    try {
        const info = await read()
        if (info) useImportState.setState({file: info, title: info.filename, phase: {step: 'ready'}})
        else useImportState.setState({phase: {step: file ? 'ready' : 'pick'}})
    } catch (error) {
        useImportState.setState({phase: {step: 'failed', error: errorMessage(error)}})
    }
}

/**
 * The import is complete: the meeting is filed and given the pinned summary
 * language, then speakers and the automatic summary run as after a
 * recording (#206). The post-call runner owns those steps, so closing the
 * sheet, or the window to the tray, does not stop them.
 */
async function finishImport(
    result: ImportResult,
    pinnedSummaryLanguage: string | null,
    client: QueryClient,
    openMeeting: (meetingId: string) => void,
) {
    const meetingId = result.meeting_id
    const {folder} = useImportState.getState()
    const [filed, language] = await Promise.allSettled([
        folder ? setMeetingFolder(meetingId, folder.id) : null,
        pinnedSummaryLanguage ? saveMeetingSummaryLanguage(meetingId, pinnedSummaryLanguage) : null,
    ])
    if (filed.status === 'rejected') {
        toast.warning(`Couldn’t file the meeting in ${folder?.name}`, {description: errorMessage(filed.reason)})
    }
    if (language.status === 'rejected') {
        toast.warning('Couldn’t apply the default summary language', {description: 'The meeting was imported; choose its summary language in Summary options.'})
    }
    // After the summary language, which the summary step reads.
    if (result.segments_count > 0) postCallControls.afterImport(meetingId)
    await Promise.all([
        client.invalidateQueries({queryKey: meetingKeys.lists()}),
        client.invalidateQueries({queryKey: folderKeys.all}),
    ])
    toast.success('Recording imported', {
        description: result.segments_count > 0
            ? `${result.segments_count} transcript ${result.segments_count === 1 ? 'line' : 'lines'}.`
            : 'No speech was found in it.',
    })
    // The import is over: the next opening starts from an empty form,
    // which the opening skips while the phase still says importing.
    resetImport()
    closeDialog('import')
    openMeeting(meetingId)
}

async function stopImport() {
    useImportState.setState({phase: {step: 'cancelling'}})
    // Rejects when native already finished; its event then settles the sheet.
    await cancelImport().catch(() => undefined)
}

function ImportForm({request, completeHeard}: { request: Extract<OpenedDialog, { kind: 'import' }>, completeHeard: boolean }) {
    const folders = useQuery(foldersQuery)
    const meetingLanguage = useMeetingLanguageStore((state) => state.value)
    const models = useSpeechModels()

    const {phase, file, title, rejectedDrop, dragging} = useImportState()
    const [folderId, setFolderId] = useState(NO_FOLDER)
    const [advanced, setAdvanced] = useState(false)
    const [language, setLanguage] = useState(meetingLanguage)
    const [chosenModel, setModel] = useState<string>()
    const [listening, setListening] = useState(0)
    const model = chosenModel ?? models.initial
    const engine = parseSpeechModel(model)
    const parakeet = engine?.provider === 'parakeet'
    const busy = isRunning(phase)

    // Each opening starts from an empty form, unless an import runs; a file
    // dropped on the window comes with the request, as the sheet opens or
    // onto it while it is open.
    useEffect(() => {
        if (!request.path && !isRunning(useImportState.getState().phase)) resetImport()
    }, [request.seq, request.path])
    useEffect(() => {
        if (request.path) void checkFile(() => checkAudioFile(request.path as string))
    }, [request.path])

    const counted = () => setListening((count) => count + 1)
    useNativeEvent(IMPORT_PROGRESS_EVENT, (progress) => {
        if (phase.step === 'importing') useImportState.setState({phase: {step: 'importing', progress}})
    }, {onListening: counted})
    useNativeEvent(IMPORT_ERROR_EVENT, ({error}) => {
        if (!busy) return
        if (phase.step === 'cancelling' || /cancel/i.test(error)) {
            toast.info('Import cancelled')
            useImportState.setState({phase: {step: file ? 'ready' : 'pick'}})
            closeDialog('import')
        } else {
            useImportState.setState({phase: {step: 'failed', error}})
        }
    }, {onListening: counted})
    // Native can fail at once (a file gone since its check), so the three
    // listeners must exist before the start: these two register as the
    // sheet opens, long before a file is chosen and Import pressed, and the
    // sheet's own complete listener before that.
    const listeners = listening >= 2 && completeHeard

    const submit = async (event: FormEvent) => {
        event.preventDefault()
        if (phase.step === 'failed') return useImportState.setState({phase: {step: file ? 'ready' : 'pick'}})
        if (!file || phase.step !== 'ready' || !listeners) return
        const folder = folderId === NO_FOLDER ? null : folders.data?.find((item) => item.id === folderId) ?? null
        useImportState.setState({phase: {step: 'importing', progress: null}, folder: folder && {id: folder.id, name: folder.name}})
        try {
            const chosen = title.trim()
            await startImport({
                sourcePath: file.path,
                title: chosen || file.filename,
                titleIsManual: chosen !== '' && chosen !== file.filename,
                language: parakeet || language === DETECT_LANGUAGE ? null : language,
                model: engine?.model ?? null,
                provider: engine?.provider ?? null,
            })
        } catch (error) {
            useImportState.setState({phase: {step: 'failed', error: errorMessage(error)}})
        }
    }

    if (phase.step === 'failed') {
        return (
            <Form id={FORM_ID} onSubmit={(event) => void submit(event)}>
                <Failure role="alert">{phase.error}</Failure>
            </Form>
        )
    }

    const progress = phase.step === 'importing' ? phase.progress : null
    const percent = Math.round(progress?.progress_percentage ?? 0)
    const folderOptions = [{value: NO_FOLDER, label: 'No folder'}, ...(folders.data ?? []).map((item) => ({value: item.id, label: item.name}))]

    return (
        <Form id={FORM_ID} onSubmit={(event) => void submit(event)} aria-busy={busy || phase.step === 'checking'}>
            {!busy && (
                <>
                    <Drop
                        type="button"
                        $dragging={dragging}
                        disabled={phase.step === 'checking'}
                        aria-busy={phase.step === 'checking' || undefined}
                        aria-label={file ? 'Choose another file or drop one here' : 'Choose a file or drop one here'}
                        aria-describedby={file ? undefined : `${FORM_ID}-formats`}
                        onClick={() => void checkFile(chooseAudioFile)}
                    >
                        <DownloadSimpleIcon size={20} aria-hidden/>
                        {dragging ? 'Drop to import this recording' : 'Drop an audio or video file here'}
                        <ChooseLook>
                            {phase.step === 'checking' && <Spinner delayed/>}
                            {file ? 'Choose another file' : 'Choose a file'}
                        </ChooseLook>
                        {!file && <Hint id={`${FORM_ID}-formats`}>{AUDIO_FORMATS_TEXT}</Hint>}
                    </Drop>
                    {rejectedDrop && (
                        <Rejected role="alert">
                            That isn’t an audio or video file. Drop one of these: {AUDIO_FORMATS_TEXT}.
                        </Rejected>
                    )}
                </>
            )}
            {file && (
                <File>
                    <WaveformIcon size={16} aria-hidden/>
                    <FileText>
                        <FileName>{file.path.split(/[\\/]/).pop() || file.filename}</FileName>
                        <Hint>{fileLength(file.duration_seconds)}, {file.format}</Hint>
                    </FileText>
                    {!busy && (
                        <IconButton
                            label="Remove the file"
                            onClick={resetImport}
                        >
                            <XIcon size={10} aria-hidden/>
                        </IconButton>
                    )}
                </File>
            )}
            {busy ? (
                <Progress>
                    <ProgressBar label="Importing the recording" value={percent}/>
                    <ProgressLine>
                        <span role="status">{phase.step === 'cancelling' ? 'Stopping the import…' : progress?.message || 'Starting the import…'}</span>
                        <Percent>{percent}%</Percent>
                    </ProgressLine>
                </Progress>
            ) : file && (
                <>
                    <SettingsGroup>
                        <SettingsRow
                            label="Title"
                            control={(
                                <Field>
                                    <TextField size="sm" value={title} onChange={(event) => useImportState.setState({title: event.target.value})}/>
                                </Field>
                            )}
                        />
                        <SettingsRow
                            label="Folder"
                            control={<Select options={folderOptions} value={folderId} onValueChange={setFolderId}/>}
                        />
                    </SettingsGroup>
                    <Disclosure type="button" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
                        Advanced options
                        <CaretDownIcon size={10} aria-hidden/>
                    </Disclosure>
                    <Collapse open={advanced}>
                        <SettingsGroup note="For this import only.">
                            <SettingsRow
                                label="Language"
                                description={parakeet ? 'Parakeet always detects the language' : undefined}
                                control={(
                                    <Select
                                        options={LANGUAGE_OPTIONS}
                                        value={parakeet ? DETECT_LANGUAGE : language}
                                        onValueChange={setLanguage}
                                        disabled={parakeet}
                                    />
                                )}
                            />
                            <SettingsRow
                                label="Model"
                                description={!models.pending && models.choices.length === 0 ? 'No speech model is downloaded' : undefined}
                                control={(
                                    <Select
                                        options={models.choices}
                                        value={model}
                                        onValueChange={setModel}
                                        placeholder={models.pending ? 'Loading…' : 'None'}
                                        pending={models.pending}
                                        disabled={models.choices.length === 0}
                                    />
                                )}
                            />
                        </SettingsGroup>
                    </Collapse>
                </>
            )}
        </Form>
    )
}
