import type {ComponentType} from 'react'
import type {paths} from '@/lib/paths'
import {AgentsPage} from '../components/AgentsPage'
import {ChosenAppsPage} from '../components/ChosenAppsPage'
import type {SubpageProps} from '../components/subpage'
import {SummaryModelPage} from '../components/summaryModel/SummaryModelPage'
import {TemplatesPage} from '../components/TemplatesPage'
import type {SettingsSection} from '../sections'

export type SettingsPageId = Parameters<typeof paths.settingsPage>[0]

export interface SettingsPageEntry {
    title: string
    /** The section Back returns to with Advanced on, and search names it in. */
    section: SettingsSection
    /** The page below its head; settings search also renders it, unseen, to find its rows. */
    Page: ComponentType<SubpageProps>
}

/** The pages inside Settings, in the order search lists them. */
export const SETTINGS_PAGES: Record<SettingsPageId, SettingsPageEntry> = {
    'chosen-apps': {title: 'Chosen apps', section: 'recording', Page: ChosenAppsPage},
    'summary-model': {title: 'Summary model', section: 'ai', Page: SummaryModelPage},
    templates: {title: 'Summary templates', section: 'ai', Page: TemplatesPage},
    agents: {title: 'Connect an agent', section: 'advanced', Page: AgentsPage},
}

// Own keys only: `in` would also take `constructor` and its kind.
export const isSettingsPage = (page: string | undefined): page is SettingsPageId =>
    page !== undefined && Object.hasOwn(SETTINGS_PAGES, page)
