import {type FormEvent, useState} from 'react'
import {PlusIcon, XIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {
    saveCustomTemplateMutation,
    type Template,
    type TemplateSection,
    type TemplateSectionFormat,
    templateQuery,
    templatesQuery,
} from '@/api/templates'
import {Button, IconButton} from '@/components/ui/Button'
import {Select} from '@/components/ui/Select'
import {Sheet, SheetClose} from '@/components/ui/Sheet'
import {Spinner} from '@/components/ui/Spinner'
import {TextArea, TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {closeDialog, type OpenedDialog, openDialog, useDialog} from '@/lib/dialogs'

const FORM_ID = 'template-editor'

const FORMATS: readonly { value: TemplateSectionFormat, label: string }[] = [
    {value: 'paragraph', label: 'Paragraph'},
    {value: 'list', label: 'List'},
    {value: 'table', label: 'Table'},
    {value: 'string', label: 'Single line'},
]

/** A section being edited; `key` keeps React's rows apart as sections come and go. */
type Draft = TemplateSection & { key: number }

let nextKey = 0
const draft = (section: TemplateSection): Draft => ({...section, key: nextKey++})
const emptySection = () => draft({title: '', instruction: '', format: 'list'})

/**
 * A new template's id from its name, as native would clean it
 * (`sanitize_template_id` in summary/templates/loader.rs): ASCII letters,
 * digits, `-` and `_`. A name with none of them (all Cyrillic, say) gets
 * an id of its own instead of an empty one.
 */
function templateIdFor(name: string): string | null {
    return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || null
}

const Form = styled.form`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

const Heading = styled.h3`
    margin: ${({theme}) => theme.space[1]} 0 0;
    ${({theme}) => theme.text.label};
    color: ${({theme}) => theme.colors.text};
`

const Sections = styled.ol`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[2]};
    margin: 0;
    padding: 0;
    list-style: none;
`

const Section = styled.li`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[2]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
`

const SectionHead = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};

    > :first-child {
        flex: 1;
        min-width: 0;
    }
`

const Add = styled(Button)`
    align-self: flex-start;
`

const Problem = styled.p`
    margin: 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.text};
`

const Waiting = styled.div`
    display: flex;
    justify-content: center;
    padding: ${({theme}) => theme.space[6]};
`

/** Why the template cannot be saved yet, or null. */
function problemOf(name: string, description: string, sections: Draft[], taken: boolean): string | null {
    if (!name.trim()) return 'Give the template a name.'
    if (taken) return 'A template with this name exists. Choose another name, or edit that one.'
    if (!description.trim()) return 'Say what the template is for.'
    if (sections.length === 0) return 'Add a section.'
    if (sections.some((section) => !section.title.trim() || !section.instruction.trim())) return 'Every section needs a title and an instruction.'
    return null
}

/**
 * The template editor: a summary template's name, description and sections
 * (title, format, what the model writes there), in order. An existing
 * template saves under its id, so a built-in one saved here becomes the
 * user's own copy, which overrides it; a new one takes an id from its name.
 * Opened from Summary options it goes back there as it closes, on the
 * template it saved.
 */
export function TemplateSheet() {
    const {open, request} = useDialog('template')
    const save = useMutation(saveCustomTemplateMutation)

    const leave = (templateId?: string) => {
        if (request?.returnTo) openDialog({...request.returnTo, templateId: templateId ?? request.returnTo.templateId})
        else closeDialog('template')
    }

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => !next && !save.isPending && leave()}
            title={request?.templateId ? 'Edit template' : 'New template'}
            description="The summary is written in these sections, in this order."
            footer={(
                <>
                    <SheetClose asChild><Button variant="ghost">Cancel</Button></SheetClose>
                    <Button variant="filled" type="submit" form={FORM_ID} pending={save.isPending}>Save template</Button>
                </>
            )}
        >
            {request && (
                <TemplateForm
                    key={request.seq}
                    request={request}
                    onSave={(templateId, template) => save.mutate({templateId, template}, {
                        onSuccess: (savedId) => {
                            toast.success(`Template “${template.name}” saved`)
                            leave(savedId)
                        },
                        onError: (error) => toast.error('Couldn’t save the template', {description: error.message}),
                    })}
                />
            )}
        </Sheet>
    )
}

interface TemplateFormProps {
    request: OpenedDialog<'template'>
    onSave: (templateId: string, template: Template) => void
}

function TemplateForm({request, onSave}: TemplateFormProps) {
    const editing = request.templateId
    const stored = useQuery({...templateQuery(editing ?? ''), enabled: !!editing})
    const templates = useQuery(templatesQuery)
    if (editing && stored.isPending) return <Waiting aria-busy="true"><Spinner delayed/></Waiting>
    if (editing && stored.isError) return <Problem role="alert">{stored.error.message}</Problem>
    return <Fields templateId={editing} initial={stored.data} taken={(templates.data ?? []).map(({id}) => id)} onSave={onSave}/>
}

interface FieldsProps {
    templateId: string | undefined
    initial: Template | undefined
    taken: string[]
    onSave: (templateId: string, template: Template) => void
}

function Fields({templateId, initial, taken, onSave}: FieldsProps) {
    const [name, setName] = useState(initial?.name ?? '')
    const [description, setDescription] = useState(initial?.description ?? '')
    const [sections, setSections] = useState<Draft[]>(() => initial?.sections.map(draft) ?? [emptySection()])
    const [tried, setTried] = useState(false)
    const id = templateId ?? templateIdFor(name)
    const problem = problemOf(name, description, sections, !templateId && id !== null && taken.includes(id))

    const change = (key: number, patch: Partial<TemplateSection>) =>
        setSections((all) => all.map((section) => (section.key === key ? {...section, ...patch} : section)))

    const submit = (event: FormEvent) => {
        event.preventDefault()
        setTried(true)
        if (problem) return
        onSave(id ?? `custom_${Date.now().toString(36)}`, {
            name: name.trim(),
            description: description.trim(),
            // The item hints of a stored section stay as they were.
            sections: sections.map(({key: _key, ...section}) => ({...section, title: section.title.trim(), instruction: section.instruction.trim()})),
        })
    }

    return (
        <Form id={FORM_ID} onSubmit={submit} noValidate>
            <TextField label="Name" value={name} placeholder="Client discovery call" onChange={(event) => setName(event.target.value)}/>
            <TextField label="Description" value={description} placeholder="What is this template for?" onChange={(event) => setDescription(event.target.value)}/>
            <Heading>Sections</Heading>
            <Sections>
                {sections.map((section, index) => {
                    const named = section.title.trim() || `section ${index + 1}`
                    return (
                        <Section key={section.key}>
                            <SectionHead>
                                <TextField
                                    size="sm"
                                    aria-label="Section title"
                                    value={section.title}
                                    placeholder="Action items"
                                    onChange={(event) => change(section.key, {title: event.target.value})}
                                />
                                <Select
                                    label={`Format of ${named}`}
                                    options={FORMATS}
                                    value={section.format}
                                    onValueChange={(format) => change(section.key, {format})}
                                />
                                <IconButton
                                    label={`Remove ${named}`}
                                    onClick={() => setSections((all) => all.filter((other) => other.key !== section.key))}
                                >
                                    <XIcon size={10} aria-hidden/>
                                </IconButton>
                            </SectionHead>
                            <TextArea
                                aria-label={`Instruction for ${named}`}
                                rows={2}
                                value={section.instruction}
                                placeholder="What should the model write here? For example: each action item with its owner."
                                onChange={(event) => change(section.key, {instruction: event.target.value})}
                            />
                        </Section>
                    )
                })}
            </Sections>
            <Add size="sm" variant="ghost" type="button" onClick={() => setSections((all) => [...all, emptySection()])}>
                <PlusIcon size={12} aria-hidden/>
                Add section
            </Add>
            {tried && problem && <Problem role="alert">{problem}</Problem>}
        </Form>
    )
}
