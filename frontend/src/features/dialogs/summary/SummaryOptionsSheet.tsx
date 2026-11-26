import {type FormEvent, type KeyboardEvent, useRef, useState} from 'react'
import {queryOptions, useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {getMeetingSummaryLanguage, meetingKeys, saveMeetingSummaryLanguage, summaryQuery} from '@/api/meetings'
import {builtInModelsQuery} from '@/api/models'
import {addRecentSummaryLanguage, type SummaryModelConfig, summaryModelQuery, useRecentSummaryLanguagesStore} from '@/api/preferences'
import {defaultTemplateQuery, templatesQuery} from '@/api/templates'
import {useWriteSummary} from '@/components/summary/writeSummary'
import {Button} from '@/components/ui/Button'
import {Select} from '@/components/ui/Select'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {Spinner} from '@/components/ui/Spinner'
import {TextArea} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, openDialog, useDialog} from '@/lib/dialogs'
import {matchesHotkey} from '@/lib/hotkeys'
import {DETECT_LANGUAGE, SUMMARY_LANGUAGES, summaryLanguageLabel} from '@/lib/languages'
import {paths} from '@/lib/paths'

const FORM_ID = 'summary-options'

const SUBMIT = {code: 'Enter', mod: true} as const

// Summary options' own read of the meeting's language; Write again reads it natively too.
const meetingLanguageQuery = (meetingId: string) => queryOptions({
    queryKey: [...meetingKeys.detail(meetingId), 'summary-language'],
    queryFn: () => getMeetingSummaryLanguage(meetingId),
})

const PROVIDERS: Record<string, string> = {
    'builtin-ai': 'Built-in',
    claude: 'Claude',
    openai: 'OpenAI',
    groq: 'Groq',
    openrouter: 'OpenRouter',
    ollama: 'Ollama',
    'custom-openai': 'Custom server',
}

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

const Note = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Waiting = styled.div`
    display: flex;
    justify-content: center;
    padding: ${({theme}) => theme.space[6]};
`

const FootLink = styled(Button)`
    margin-right: auto;
`

/** "Built-in (Qwen 3.5 4B)", "Claude (claude-sonnet-5-5)", or null with none chosen. */
function modelLabel(config: SummaryModelConfig | null | undefined, builtIn: { name: string, display_name: string }[] | undefined) {
    if (!config?.provider || !config.model) return null
    const name = config.provider === 'builtin-ai'
        ? builtIn?.find((model) => model.name === config.model)?.display_name ?? config.model
        : config.model
    return `${PROVIDERS[config.provider] ?? config.provider} (${name})`
}

/**
 * Summary options, from the summary's Write again: the template for this
 * run (the stored default to start with), the meeting's summary language
 * (kept for the meeting), the summary model (shown; Change opens its page,
 * since it applies to every meeting) and what to focus on this time.
 * Ctrl/⌘ Enter in the instructions writes it. A summary the user edited is
 * said to be replaced, where the old UI asked in a sheet of its own.
 */
export function SummaryOptionsSheet() {
    const slot = useDialog()
    const request = slot.request?.kind === 'summary' ? slot.request : null
    const open = slot.open && request !== null
    const navigate = useNavigate()
    const [writing, setWriting] = useState(false)
    const defaultTemplate = useQuery({...defaultTemplateQuery, enabled: open})
    // The template chosen in this opening; Edit templates… edits it.
    const [choice, setChoice] = useState<{ seq: number, templateId: string }>()
    const seq = request?.seq ?? 0
    const templateId = (choice?.seq === seq ? choice.templateId : request?.templateId) ?? defaultTemplate.data

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && !writing && closeDialog('summary')}
            title="Summary options"
            footer={(
                <>
                    <FootLink
                        variant="ghost"
                        onClick={() => request && openDialog({
                            kind: 'template',
                            templateId,
                            returnTo: {kind: 'summary', meetingId: request.meetingId, templateId},
                        })}
                    >
                        Edit templates…
                    </FootLink>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID} pending={writing}>Write again</Button>
                </>
            )}
        >
            {request && (
                <SummaryForm
                    key={request.seq}
                    request={request}
                    templateId={templateId}
                    defaultTemplateId={defaultTemplate.data}
                    onTemplate={(id) => setChoice({seq, templateId: id})}
                    onWriting={setWriting}
                    onChangeModel={() => {
                        closeDialog('summary')
                        void navigate(paths.settingsPage('summary-model'))
                    }}
                />
            )}
        </Sheet>
    )
}

interface SummaryFormProps {
    request: Extract<OpenedDialog, { kind: 'summary' }>
    /** Undefined until the default template is read. */
    templateId: string | undefined
    /** Marked in the list: the list keeps one order whatever the default (#218). */
    defaultTemplateId: string | undefined
    onTemplate: (templateId: string) => void
    onWriting: (writing: boolean) => void
    onChangeModel: () => void
}

function SummaryForm({request, templateId, defaultTemplateId, onTemplate, onWriting, onChangeModel}: SummaryFormProps) {
    const {meetingId} = request
    const templates = useQuery(templatesQuery)
    const saved = useQuery(meetingLanguageQuery(meetingId))
    const summary = useQuery(summaryQuery(meetingId))
    const config = useQuery(summaryModelQuery)
    const builtIn = useQuery({...builtInModelsQuery, enabled: config.data?.provider === 'builtin-ai'})
    const recents = useRecentSummaryLanguagesStore((state) => state.value)
    const {write} = useWriteSummary(meetingId)

    const [chosenLanguage, setLanguage] = useState<string>()
    const [focus, setFocus] = useState('')
    const savedLanguage = saved.data ?? DETECT_LANGUAGE
    const language = chosenLanguage ?? savedLanguage

    // One submit at a time: ⌘↩ pressed twice would save the language twice,
    // and the second write's refusal would end the first's pending state
    // while it still starts. A ref, since the second press comes before a render.
    const submitting = useRef(false)
    const submit = async (event?: FormEvent) => {
        event?.preventDefault()
        if (submitting.current) return
        submitting.current = true
        onWriting(true)
        try {
            if (language !== savedLanguage) {
                try {
                    await saveMeetingSummaryLanguage(meetingId, language === DETECT_LANGUAGE ? null : language)
                    if (language !== DETECT_LANGUAGE) addRecentSummaryLanguage(language)
                } catch (error) {
                    toast.error('Couldn’t change the summary language', {description: errorMessage(error)})
                    return
                }
            }
            const started = await write({again: true, templateId, customPrompt: focus.trim() || undefined})
            if (started) closeDialog('summary')
        } finally {
            submitting.current = false
            onWriting(false)
        }
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!matchesHotkey(SUBMIT, event.nativeEvent)) return
        event.preventDefault()
        void submit()
    }

    if (templates.isPending || !templateId || saved.isPending || config.isPending) {
        return <Waiting aria-busy="true"><Spinner delayed/></Waiting>
    }

    const known = new Set(SUMMARY_LANGUAGES.map(({code}) => code))
    const recent = recents.filter((code) => known.has(code))
    const languageOptions = [
        {value: DETECT_LANGUAGE, label: 'Same as the transcript'},
        ...recent.map((code) => ({value: code, label: summaryLanguageLabel(code)})),
        ...SUMMARY_LANGUAGES.filter(({code}) => !recent.includes(code)).map(({code, label}) => ({value: code, label})),
    ]
    const templateOptions = (templates.data ?? []).map(({id, name}) => ({value: id, label: id === defaultTemplateId ? `${name} (default)` : name}))
    const model = modelLabel(config.data, builtIn.data)

    return (
        <Form id={FORM_ID} onSubmit={(event) => void submit(event)}>
            <SettingsGroup>
                <SettingsRow
                    label="Template"
                    control={<Select options={templateOptions} value={templateId} onValueChange={onTemplate}/>}
                />
                <SettingsRow
                    label="Language"
                    description="For this meeting only"
                    control={<Select options={languageOptions} value={language} onValueChange={setLanguage}/>}
                />
                <SettingsRow
                    label="Model"
                    description={model ? `${model}. Changing it applies to every meeting` : 'No summary model is chosen'}
                    control={<Button size="sm" variant="ghost" onClick={onChangeModel}>{model ? 'Change' : 'Choose'}</Button>}
                />
            </SettingsGroup>
            <TextArea
                label="Write it again"
                rows={3}
                placeholder="Anything to focus on? For example: only the decisions about the pilot"
                value={focus}
                onChange={(event) => setFocus(event.target.value)}
                onKeyDown={onKeyDown}
            />
            {summary.data?.userEdited && <Note>Writing it again replaces your edits to the summary. Your notes stay.</Note>}
        </Form>
    )
}
