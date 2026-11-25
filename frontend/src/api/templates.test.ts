import type {MutationOptions, QueryClient} from '@tanstack/react-query'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {
    defaultTemplateQuery,
    deleteCustomTemplateMutation,
    FALLBACK_TEMPLATE_ID,
    saveCustomTemplateMutation,
    setDefaultTemplateMutation,
    type Template,
    templateKeys,
    templateQuery,
    templatesQuery,
} from './templates'

function run<TData, TVariables>(client: QueryClient, options: MutationOptions<TData, Error, TVariables>, variables: NoInfer<TVariables>) {
    return client.getMutationCache().build(client, options).execute(variables)
}

const DISCOVERY: Template = {
    name: 'Client discovery call',
    description: 'What the client needs and what happens next.',
    sections: [
        {title: 'Needs', instruction: 'List what the client says they need.', format: 'list'},
        {title: 'Next steps', instruction: 'Who does what by when.', format: 'table', item_format: '| Owner | Step | Due |'},
    ],
}

describe('summary templates', () => {
    it('lists the built-in templates by id, none of them custom', async () => {
        const client = createTestQueryClient()

        const list = await client.fetchQuery(templatesQuery)

        expect(list.map(({id}) => id)).toEqual([
            'daily_standup',
            'project_sync',
            'psychatric_session',
            'retrospective',
            'sales_marketing_client_call',
            'standard_meeting',
        ])
        expect(list.find(({id}) => id === 'standard_meeting')).toEqual({
            id: 'standard_meeting',
            name: 'Standard Meeting Notes',
            description: expect.any(String),
            custom: false,
        })
        expect(list.every(({custom}) => !custom)).toBe(true)
    })

    it('reads one template whole', async () => {
        const client = createTestQueryClient()

        const template = await client.fetchQuery(templateQuery('standard_meeting'))

        expect(template.sections.map(({title, format}) => [title, format])).toEqual([
            ['Summary', 'paragraph'],
            ['Key Decisions', 'list'],
            ['Action Items', 'table'],
            ['Discussion Highlights', 'paragraph'],
        ])
    })

    it('saves a custom template under the id native writes, and refreshes the list', async () => {
        const client = createTestQueryClient()
        await client.fetchQuery(templatesQuery)

        const id = await run(client, saveCustomTemplateMutation, {templateId: 'Client discovery!', template: DISCOVERY})

        expect(id).toBe('client_discovery')
        expect(client.getQueryState(templateKeys.list())?.isInvalidated).toBe(true)
        const list = await client.fetchQuery(templatesQuery)
        expect(list.find((template) => template.id === 'client_discovery')).toMatchObject({name: 'Client discovery call', custom: true})
        expect(await client.fetchQuery(templateQuery('client_discovery'))).toEqual(DISCOVERY)
    })

    it('refuses a template native would not load', async () => {
        const client = createTestQueryClient()

        await expect(run(client, saveCustomTemplateMutation, {templateId: 'empty', template: {...DISCOVERY, sections: []}}))
            .rejects.toThrow('Template must have at least one section')
        expect(mockState.templates.custom).toEqual({})
    })

    it('uses the fallback until a default is stored, then the stored one', async () => {
        const client = createTestQueryClient()
        expect(await client.fetchQuery(defaultTemplateQuery)).toBe(FALLBACK_TEMPLATE_ID)

        await run(client, setDefaultTemplateMutation, 'daily_standup')

        expect(client.getQueryState(templateKeys.default())?.isInvalidated).toBe(true)
        expect(await client.fetchQuery(defaultTemplateQuery)).toBe('daily_standup')
    })

    it('stores no template that does not load', async () => {
        const client = createTestQueryClient()

        await expect(run(client, setDefaultTemplateMutation, 'nothing_here')).rejects.toThrow("Template 'nothing_here' not found")
        expect(mockState.templates.defaultId).toBeNull()
    })

    it('falls back when the custom default is deleted', async () => {
        const client = createTestQueryClient()
        await run(client, saveCustomTemplateMutation, {templateId: 'client_discovery', template: DISCOVERY})
        await run(client, setDefaultTemplateMutation, 'client_discovery')
        expect(await client.fetchQuery(defaultTemplateQuery)).toBe('client_discovery')

        await run(client, deleteCustomTemplateMutation, 'client_discovery')

        expect(await client.fetchQuery(defaultTemplateQuery)).toBe(FALLBACK_TEMPLATE_ID)
        expect((await client.fetchQuery(templatesQuery)).some(({id}) => id === 'client_discovery')).toBe(false)
    })

    it('brings a built-in back when its custom override is deleted', async () => {
        const client = createTestQueryClient()
        await run(client, saveCustomTemplateMutation, {templateId: 'standard_meeting', template: DISCOVERY})
        expect(await client.fetchQuery(templateQuery('standard_meeting'))).toMatchObject({name: 'Client discovery call'})

        await run(client, deleteCustomTemplateMutation, 'standard_meeting')

        expect(await client.fetchQuery(templateQuery('standard_meeting'))).toMatchObject({name: 'Standard Meeting Notes'})
        expect((await client.fetchQuery(templatesQuery)).find(({id}) => id === 'standard_meeting')?.custom).toBe(false)
    })

    it('cannot delete a built-in template', async () => {
        const client = createTestQueryClient()

        await expect(run(client, deleteCustomTemplateMutation, 'daily_standup')).rejects.toThrow("Custom template 'daily_standup' not found")
    })
})
