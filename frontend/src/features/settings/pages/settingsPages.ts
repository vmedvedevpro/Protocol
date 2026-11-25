import type {ComponentType} from 'react'
import type {paths} from '@/lib/paths'
import {AgentsPage} from '../components/AgentsPage'
import {ChosenAppsPage} from '../components/ChosenAppsPage'
import {SpeechModelsPage} from '../components/SpeechModelsPage'
import type {SubpageProps} from '../components/subpage'
import {SUMMARY_PROVIDERS} from '../components/summaryModel'
import {SummaryModelPage} from '../components/summaryModel/SummaryModelPage'
import {TemplatesPage} from '../components/TemplatesPage'
import type {SettingsSection} from '../sections'

export type SettingsPageId = Parameters<typeof paths.settingsPage>[0]

/** A row of a page as search finds it: its label and description as the page shows them. */
export interface IndexedRow {
    label: string
    description?: string
}

export interface SettingsPageEntry {
    title: string
    /** The section Back returns to with Advanced on, and search names it in. */
    section: SettingsSection
    Page: ComponentType<SubpageProps>
    /**
     * The page's own rows, every one it can show, for search, which reads
     * them without rendering the page. Rows that list data (models,
     * templates, apps) and passing status rows are left out. Each page's
     * test checks that the rows it renders are these.
     */
    rows: readonly IndexedRow[]
}

const providers = Object.values(SUMMARY_PROVIDERS).map(({label, description}) => ({label, description}))

/** The pages inside Settings, in the order search lists them. */
export const SETTINGS_PAGES: Record<SettingsPageId, SettingsPageEntry> = {
    'chosen-apps': {
        title: 'Chosen apps',
        section: 'recording',
        Page: ChosenAppsPage,
        rows: [
            {label: 'Add an app'},
            {label: 'An app that is not open'},
        ],
    },
    'summary-model': {
        title: 'Summary model',
        section: 'ai',
        Page: SummaryModelPage,
        rows: [
            ...providers,
            {label: 'API key'},
            {label: 'Model'},
            {label: 'Maximum summary length', description: 'Optional. Empty uses the model’s default'},
            {label: 'Endpoint', description: 'Optional'},
            {label: 'gemma3:1b', description: 'A small model to start with'},
            {label: 'Endpoint URL'},
            {label: 'Model name'},
            {label: 'Advanced options'},
            {label: 'Max tokens'},
            {label: 'Temperature'},
            {label: 'Top P'},
            {label: 'Test connection', description: 'Asks the server for one short answer'},
        ],
    },
    'speech-models': {
        title: 'Speech models',
        section: 'ai',
        Page: SpeechModelsPage,
        // The models themselves are data; these are the rows of this computer's Intel paths.
        rows: [
            {label: 'Parakeet'},
            {label: "Intel's libraries", description: 'Parakeet runs on the Intel NPU once they are downloaded'},
            {label: 'Whisper for the Intel GPU', description: 'A faster Whisper for this computer, used after meetings'},
        ],
    },
    templates: {
        title: 'Summary templates',
        section: 'ai',
        Page: TemplatesPage,
        rows: [
            {label: 'Delete this template', description: 'Summaries already written keep it'},
        ],
    },
    agents: {
        title: 'Connect an agent',
        section: 'advanced',
        Page: AgentsPage,
        rows: [
            {label: 'Run once in a terminal', description: 'Claude Code then offers Protocol’s tools in every project.'},
            {label: 'Add to Claude Desktop', description: 'Installs the Protocol extension'},
            {label: 'Set up by hand'},
            {label: 'Add to the Claude Desktop configuration'},
        ],
    },
}

/** The labels of an entry's rows, for the tests that hold a page to its index. */
export const indexedLabels = (id: SettingsPageId) => SETTINGS_PAGES[id].rows.map(({label}) => label)

// Own keys only: `in` would also take `constructor` and its kind.
export const isSettingsPage = (page: string | undefined): page is SettingsPageId =>
    page !== undefined && Object.hasOwn(SETTINGS_PAGES, page)
