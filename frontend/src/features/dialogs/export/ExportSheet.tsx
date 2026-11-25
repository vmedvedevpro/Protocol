import {useState} from 'react'
import {useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {actionItemsQuery} from '@/api/actionItems'
import {errorMessage} from '@/api/core'
import {meetingQuery, meetingTranscriptsQuery, summaryQuery} from '@/api/meetings'
import {useUserName} from '@/api/preferences'
import {Button} from '@/components/ui/Button'
import {SegmentedControl} from '@/components/ui/SegmentedControl'
import {SettingsRadioGroup, SettingsRadioRow} from '@/components/ui/SettingsRow'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, useDialog} from '@/lib/dialogs'
import {
    type ExportContent,
    exportableSummary,
    exportDocument,
    exportFileName,
    type ExportFormat,
    type ExportSource,
    type LinkStyle,
    readLinkStyle,
    saveLinkStyle,
} from './exportDocument'
import {saveExport} from './formats'

interface Option<T extends string> {
    value: T
    label: string
    description: string
}

const FORMATS: readonly (Option<ExportFormat> & { done: string })[] = [
    {value: 'pdf', label: 'PDF', description: 'To share or print', done: 'Exported as PDF'},
    {value: 'docx', label: 'Word', description: 'Editable .docx', done: 'Exported as Word'},
    {value: 'txt', label: 'Text', description: 'Plain .txt', done: 'Exported as text'},
    {value: 'markdown', label: 'Markdown', description: 'Formatted .md', done: 'Exported as Markdown'},
    {value: 'json', label: 'JSON', description: 'Structured data', done: 'Exported as JSON'},
    {value: 'clipboard', label: 'Clipboard', description: 'Copy formatted', done: 'Copied'},
]

const LINKS = [
    {value: 'generic', label: 'Generic'},
    {value: 'obsidian', label: 'Obsidian'},
] as const

const CONTENTS: readonly Option<ExportContent>[] = [
    {value: 'transcript', label: 'Transcript', description: 'Everything said, with timestamps'},
    {value: 'summary', label: 'Summary', description: 'The current summary'},
    {value: 'both', label: 'Transcript + Summary', description: 'A complete meeting record'},
]

const COPIED: Record<ExportContent, string> = {
    transcript: 'Transcript copied',
    summary: 'Summary copied',
    both: 'Transcript and summary copied',
}

const FORM_ID = 'export-meeting'

function dateOf(value: string): Date | null {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3.5]};
`

const LinksRow = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

const LinksText = styled.div`
    flex: 1;
    min-width: 0;
    ${({theme}) => theme.text.body};
`

const Muted = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Waiting = styled.div`
    display: flex;
    justify-content: center;
    padding: ${({theme}) => theme.space[6]};
`

/**
 * Export (the meeting menu's Export…): what to export, in which format, and
 * for Markdown the link style, kept under the old UI's key. A file goes
 * through the save dialog; Clipboard copies the Markdown. The sheet stays
 * open, and cannot be dismissed, while it exports, and stays open when the
 * save dialog is cancelled.
 */
export function ExportSheet() {
    const slot = useDialog()
    const request = slot.request?.kind === 'export' ? slot.request : null
    const open = slot.open && request !== null
    const [busy, setBusy] = useState(false)
    // Kept between openings while the app runs; the content is chosen afresh.
    const [format, setFormat] = useState<ExportFormat>('markdown')
    const title = useQuery({...meetingQuery(request?.meetingId ?? ''), enabled: !!request}).data?.title

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && !busy && closeDialog('export')}
            title="Export"
            description={title}
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost" disabled={busy}>Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID} pending={busy}>
                        {format === 'clipboard' ? 'Copy' : 'Export'}
                    </Button>
                </>
            )}
        >
            {request && <ExportForm key={request.seq} request={request} format={format} onFormat={setFormat} onBusy={setBusy}/>}
        </Sheet>
    )
}

interface ExportFormProps {
    request: Extract<OpenedDialog, { kind: 'export' }>
    format: ExportFormat
    onFormat: (format: ExportFormat) => void
    onBusy: (busy: boolean) => void
}

function ExportForm({request, format, onFormat, onBusy}: ExportFormProps) {
    const {meetingId} = request
    const userName = useUserName()
    const meeting = useQuery(meetingQuery(meetingId))
    const lines = useQuery(meetingTranscriptsQuery(meetingId))
    const summary = useQuery(summaryQuery(meetingId))
    const items = useQuery(actionItemsQuery({meetingId}))
    const [chosen, setContent] = useState<ExportContent | null>(null)
    const [linkStyle, setLinkStyle] = useState<LinkStyle>(readLinkStyle)

    if (meeting.isError || lines.isError) {
        return <Muted role="alert">{errorMessage(meeting.error ?? lines.error)}</Muted>
    }
    if (!meeting.data || !lines.data || summary.isPending || items.isPending) {
        return <Waiting aria-busy="true"><Spinner delayed/></Waiting>
    }

    const source: ExportSource = {
        meetingId,
        title: meeting.data.title,
        createdAt: dateOf(meeting.data.created_at),
        lines: lines.data,
        summary: summary.data?.data,
        actionItems: items.data ?? [],
        userName: userName || undefined,
    }
    const hasTranscript = lines.data.length > 0
    const hasSummary = !!exportableSummary(source)
    const available = (value: ExportContent) =>
        value === 'transcript' ? hasTranscript : value === 'summary' ? hasSummary : hasTranscript && hasSummary
    // The whole record when there is one, as the old UI chose.
    const content = chosen ?? (available('both') ? 'both' : hasTranscript ? 'transcript' : 'summary')

    const run = async () => {
        if (!available(content)) return
        onBusy(true)
        try {
            const markdown = exportDocument(source, content, format, linkStyle)
            if (format === 'clipboard') {
                await navigator.clipboard.writeText(markdown)
                toast.success(COPIED[content])
            } else {
                const saved = await saveExport(format, markdown, source.title, exportFileName(source.title, content))
                if (!saved) return
                toast.success(FORMATS.find((item) => item.value === format)?.done ?? 'Exported')
            }
            closeDialog('export')
        } catch (error) {
            toast.error(format === 'clipboard' ? 'Couldn’t copy the meeting' : 'Export failed', {description: errorMessage(error)})
        } finally {
            onBusy(false)
        }
    }

    return (
        <Form
            id={FORM_ID}
            onSubmit={(event) => {
                event.preventDefault()
                void run()
            }}
        >
            <SettingsRadioGroup<ExportContent> title="Content" value={content} onValueChange={setContent}>
                {CONTENTS.map(({value, label, description}) => (
                    <SettingsRadioRow
                        key={value}
                        value={value}
                        label={label}
                        description={available(value) ? description : 'Not available for this meeting'}
                        disabled={!available(value)}
                    />
                ))}
            </SettingsRadioGroup>
            <SettingsRadioGroup<ExportFormat> title="Format" layout="grid" value={format} onValueChange={onFormat}>
                {FORMATS.map((item) => <SettingsRadioRow key={item.value} value={item.value} label={item.label} description={item.description}/>)}
            </SettingsRadioGroup>
            {format === 'markdown' && (
                <LinksRow>
                    <LinksText>
                        Links
                        <Muted>{linkStyle === 'obsidian' ? 'Wikilinks to identified speakers' : 'Plain links that work everywhere'}</Muted>
                    </LinksText>
                    <SegmentedControl
                        label="Link style"
                        options={LINKS}
                        value={linkStyle}
                        onChange={(style) => {
                            setLinkStyle(style)
                            saveLinkStyle(style)
                        }}
                    />
                </LinksRow>
            )}
        </Form>
    )
}
