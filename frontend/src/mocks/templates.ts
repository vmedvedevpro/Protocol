import type {Template, TemplateInfo} from '@/api/templates'
import dailyStandup from '../../src-tauri/templates/daily_standup.json'
import projectSync from '../../src-tauri/templates/project_sync.json'
import psychiatricSession from '../../src-tauri/templates/psychatric_session.json'
import retrospective from '../../src-tauri/templates/retrospective.json'
import salesCall from '../../src-tauri/templates/sales_marketing_client_call.json'
import standardMeeting from '../../src-tauri/templates/standard_meeting.json'
import type {MockHandler} from './handlers'

/** Summary templates as native keeps them (summary/templates, summary/template_settings.rs). */
export interface MockTemplates {
    /** The built-in templates by id: the real files native bundles. */
    builtIn: Record<string, Template>
    /** The user's own files by id; one with a built-in's id overrides it. */
    custom: Record<string, Template>
    /** The stored default; null while none is stored. */
    defaultId: string | null
}

/** What native answers while no default is stored (`FALLBACK_TEMPLATE_ID` in summary/template_settings.rs). */
export const FALLBACK_TEMPLATE_ID = 'standard_meeting'

export function createMockTemplates(): MockTemplates {
    return {
        builtIn: {
            daily_standup: dailyStandup as Template,
            project_sync: projectSync as Template,
            psychatric_session: psychiatricSession as Template,
            retrospective: retrospective as Template,
            sales_marketing_client_call: salesCall as Template,
            standard_meeting: standardMeeting as Template,
        },
        custom: {},
        defaultId: null,
    }
}

/** `sanitize_template_id` in summary/templates/loader.rs. */
const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase().replace(/^_+|_+$/g, '')

export function templatesHandlers(state: {templates: MockTemplates}): Record<string, MockHandler> {
    const find = (id: string) => state.templates.custom[id] ?? state.templates.builtIn[id]
    const ids = () => [...new Set([...Object.keys(state.templates.builtIn), ...Object.keys(state.templates.custom)])].sort()
    const load = (id: string) => {
        const template = find(id)
        if (!template) throw `Template '${id}' not found. Available templates: ${ids().join(', ')}`
        return structuredClone(template)
    }
    return {
        api_list_templates: (): TemplateInfo[] => ids().map((id) => ({id, name: find(id).name, description: find(id).description})),
        api_is_custom_template: ({templateId}) => sanitize(String(templateId)) in state.templates.custom,
        api_get_template: ({templateId}) => load(String(templateId)),
        api_save_custom_template: ({templateId, templateJson}) => {
            let template: Template
            try {
                template = JSON.parse(String(templateJson)) as Template
            } catch (error) {
                throw `Failed to parse template JSON: ${String(error)}`
            }
            const id = sanitize(String(templateId))
            if (!id) throw 'Template id must contain at least one alphanumeric character'
            state.templates.custom[id] = template
            return id
        },
        api_delete_custom_template: ({templateId}) => {
            const id = sanitize(String(templateId))
            if (!(id in state.templates.custom)) throw `Custom template '${id}' not found`
            delete state.templates.custom[id]
            return null
        },
        api_get_default_template: () => {
            const stored = state.templates.defaultId
            return stored && find(stored) ? stored : FALLBACK_TEMPLATE_ID
        },
        api_set_default_template: ({templateId}) => {
            load(String(templateId))
            state.templates.defaultId = String(templateId)
            return null
        },
    }
}
