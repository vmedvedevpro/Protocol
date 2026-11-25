/**
 * Summary templates: the sections a summary is written in. Native code keeps
 * them (summary/templates): built-in ones compiled in or bundled, and custom
 * ones the user saved as JSON files, which override a built-in of the same
 * id. Settings › Summary templates lists them and stores the default; the
 * template editor and a meeting's summary options (#119) read one whole and
 * save, and pass a template to `startSummary` for one run.
 *
 * The default is stored natively (`summary/template_settings.rs`), so a run
 * that names no template, the automatic summary after a recording among
 * them, uses it without asking the UI.
 */
import {mutationOptions, type QueryClient, queryOptions} from '@tanstack/react-query'
import {command} from './core'

/** One entry of `api_list_templates`; mirrors `TemplateInfo` in summary/template_commands.rs. */
export interface TemplateInfo {
    /** The file stem: `standard_meeting`, or a custom template's sanitised id. */
    id: string
    name: string
    description: string
}

/** A template as the list shows it: with whether the user's own file supplies it. */
export interface TemplateListItem extends TemplateInfo {
    /**
     * A custom template on disk, which Delete removes. One with a built-in's
     * id overrides that built-in, which comes back after the delete.
     */
    custom: boolean
}

export type TemplateSectionFormat = 'paragraph' | 'list' | 'table' | 'string'

/** Mirrors `TemplateSection` in summary/templates/types.rs. */
export interface TemplateSection {
    title: string
    /** What the model is told to put in the section. */
    instruction: string
    format: TemplateSectionFormat
    /** A Markdown hint for each item, such as a table's header row. */
    item_format?: string
    example_item_format?: string
}

/** Mirrors `Template` in summary/templates/types.rs: what a template file holds. */
export interface Template {
    name: string
    description: string
    sections: TemplateSection[]
}

export const templateKeys = {
    all: ['templates'] as const,
    list: () => [...templateKeys.all, 'list'] as const,
    detail: (templateId: string) => [...templateKeys.all, 'detail', templateId] as const,
    default: () => [...templateKeys.all, 'default'] as const,
}

export const listTemplates = () => command<TemplateInfo[]>('api_list_templates')

/** Whether the user's own file supplies a template (`custom` above). */
export const isCustomTemplate = (templateId: string) => command<boolean>('api_is_custom_template', {templateId})

/** Sorted by id, as native lists them; a template that fails to load is left out natively. */
export async function listTemplatesWithOrigin(): Promise<TemplateListItem[]> {
    const templates = await listTemplates()
    const custom = await Promise.all(templates.map(({id}) => isCustomTemplate(id)))
    return templates.map((template, index) => ({...template, custom: custom[index]}))
}

/** One template whole, from the same copy a summary would use. */
export const getTemplate = (templateId: string) => command<Template>('api_get_template', {templateId})

/**
 * Saves a custom template, creating it or replacing the one with that id, and
 * answers the id native wrote: lower case, with anything but letters, digits,
 * `-` and `_` turned into `_`. Native validates it first and rejects an empty
 * name, description, section list, section title or instruction, or another
 * format.
 */
export const saveCustomTemplate = (templateId: string, template: Template) =>
    command<string>('api_save_custom_template', {templateId, templateJson: JSON.stringify(template, null, 2)})

/** Deletes a custom template; a built-in one rejects ("Custom template '…' not found"). */
export const deleteCustomTemplate = (templateId: string) => command<null>('api_delete_custom_template', {templateId})

/** The default template's id: always one that loads (the fallback otherwise). */
export const getDefaultTemplate = () => command<string>('api_get_default_template')

/** Stores the default template; rejects for a template that does not load. */
export const setDefaultTemplate = (templateId: string) => command<null>('api_set_default_template', {templateId})

export const templatesQuery = queryOptions({queryKey: templateKeys.list(), queryFn: listTemplatesWithOrigin})

export const templateQuery = (templateId: string) =>
    queryOptions({queryKey: templateKeys.detail(templateId), queryFn: () => getTemplate(templateId)})

export const defaultTemplateQuery = queryOptions({queryKey: templateKeys.default(), queryFn: getDefaultTemplate})

/**
 * A save or a delete can change every view of templates: the list, the
 * template itself (a delete brings back the built-in it overrode) and the
 * default (a deleted default falls back).
 */
const invalidateTemplates = (client: QueryClient) => client.invalidateQueries({queryKey: templateKeys.all})

export const saveCustomTemplateMutation = mutationOptions({
    mutationFn: ({templateId, template}: {templateId: string, template: Template}) => saveCustomTemplate(templateId, template),
    onSuccess: (_savedId, _variables, _result, {client}) => invalidateTemplates(client),
})

export const deleteCustomTemplateMutation = mutationOptions({
    mutationFn: deleteCustomTemplate,
    onSuccess: (_reply, _templateId, _result, {client}) => invalidateTemplates(client),
})

export const setDefaultTemplateMutation = mutationOptions({
    mutationFn: setDefaultTemplate,
    onSuccess: (_reply, _templateId, _result, {client}) => client.invalidateQueries({queryKey: templateKeys.default()}),
})
