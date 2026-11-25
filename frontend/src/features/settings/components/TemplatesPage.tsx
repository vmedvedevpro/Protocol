import {useMutation, useQuery} from '@tanstack/react-query'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {
    defaultTemplateQuery,
    deleteCustomTemplateMutation,
    setDefaultTemplateMutation,
    templateQuery,
    type TemplateListItem,
    type TemplateSectionFormat,
    templatesQuery,
} from '@/api/templates'
import {Button} from '@/components/ui/Button'
import {SettingsGroup, SettingsRadioGroup, SettingsRadioRow, SettingsRow} from '@/components/ui/SettingsRow'
import {toast} from '@/components/ui/toastStore'
import {SubpageGroups, SubpageScroll} from './subpage'
import {Warning} from './styles'

const Format = styled.span`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const FORMATS: Record<TemplateSectionFormat, string> = {
    paragraph: 'Paragraph',
    list: 'List',
    table: 'Table',
    string: 'Text',
}

/** The default template's sections, and Delete when it is the user's own. */
function SectionsGroup({template}: {template: TemplateListItem}) {
    const detail = useQuery(templateQuery(template.id))
    const remove = useMutation({
        ...deleteCustomTemplateMutation,
        onError: (error) => toast.error(`Couldn’t delete ${template.name}`, {description: errorMessage(error)}),
    })
    return (
        <SettingsGroup title="Sections" note="Each meeting can still use another template from its summary options.">
            {detail.isError && <SettingsRow label="Couldn’t read the template" description={errorMessage(detail.error)}/>}
            {detail.data?.sections.map((section) => (
                <SettingsRow key={section.title} label={section.title} control={<Format>{FORMATS[section.format] ?? section.format}</Format>}/>
            ))}
            {template.custom && (
                <SettingsRow
                    label="Delete this template"
                    // A custom template with a built-in's id hides that built-in until it is deleted.
                    description="Summaries already written keep it"
                    control={(
                        <Button size="sm" variant="ghost" pending={remove.isPending} onClick={() => remove.mutate(template.id)}>
                            Delete
                        </Button>
                    )}
                />
            )}
        </SettingsGroup>
    )
}

/**
 * Settings › AI › Summary templates: the template a summary uses unless its
 * meeting picks another, chosen at once (native stores it,
 * template_settings.rs), and its sections. Editing and new templates are
 * the template editor's (#119).
 */
export function TemplatesPage() {
    const templates = useQuery(templatesQuery)
    const chosen = useQuery(defaultTemplateQuery)
    const choose = useMutation({
        ...setDefaultTemplateMutation,
        onError: (error) => toast.error('Couldn’t change the default template', {description: errorMessage(error)}),
    })
    // The choice shows at once; a failure puts the stored one back.
    const value = choose.isPending ? choose.variables : chosen.data
    const current = templates.data?.find(({id}) => id === value)

    return (
        <SubpageScroll>
            <SubpageGroups>
                {(templates.isError || chosen.isError) && (
                    <Warning>Couldn’t read the templates: {errorMessage(templates.error ?? chosen.error)}</Warning>
                )}
                <SettingsRadioGroup title="Default template" value={value} onValueChange={(id) => choose.mutate(id)}>
                    {templates.data?.map((template) => (
                        <SettingsRadioRow
                            key={template.id}
                            value={template.id}
                            label={template.name}
                            badge={template.custom ? 'Yours' : undefined}
                        />
                    ))}
                </SettingsRadioGroup>
                {current && <SectionsGroup key={current.id} template={current}/>}
            </SubpageGroups>
        </SubpageScroll>
    )
}
