import type {Meta, StoryObj} from '@storybook/react-vite'
import {mockState} from '@/mocks/state'
import {SettingsStoryWindow} from '../stories/SettingsStoryWindow'
import {SettingsPage} from './SettingsPage'

function Page({path}: {path: string}) {
    return <SettingsStoryWindow path={path}><SettingsPage/></SettingsStoryWindow>
}

const meta = {
    title: 'Settings/Pages',
    component: Page,
    args: {path: '/settings/summary-model'},
} satisfies Meta<typeof Page>

export default meta

type Story = StoryObj<typeof meta>

/** Built-in AI: the models for this computer, Download, Use and Delete. */
export const SummaryModel: Story = {globals: {theme: 'light'}}

export const SummaryModelDark: Story = {globals: {theme: 'dark'}}

/** A cloud provider: its key, a model from its list, Claude's maximum length. */
export const SummaryModelClaude: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.preferences.summaryModel = {
            provider: 'claude', model: 'claude-sonnet-4-5-20250929', whisperModel: 'large-v3', apiKey: null, ollamaEndpoint: null, summaryMaxTokens: null,
        }
        mockState.preferences.apiKeys.claude = 'sk-ant-preview'
    },
}

/** Ollama's server and the models on it. */
export const SummaryModelOllama: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.preferences.summaryModel = {
            provider: 'ollama', model: 'llama3.2:3b', whisperModel: 'large-v3', apiKey: null, ollamaEndpoint: null, summaryMaxTokens: null,
        }
    },
}

export const Templates: Story = {globals: {theme: 'light'}, args: {path: '/settings/templates'}}

export const TemplatesDark: Story = {globals: {theme: 'dark'}, args: {path: '/settings/templates'}}

export const ChosenApps: Story = {globals: {theme: 'light'}, args: {path: '/settings/chosen-apps'}}

export const ChosenAppsDark: Story = {globals: {theme: 'dark'}, args: {path: '/settings/chosen-apps'}}

/** Access is on: the command for Claude Code and Add to Claude Desktop. */
export const ConnectAnAgent: Story = {
    globals: {theme: 'light'},
    args: {path: '/settings/agents'},
    beforeEach: () => {
        mockState.settings.agentsEnabled = true
    },
}

export const ConnectAnAgentDark: Story = {
    globals: {theme: 'dark'},
    args: {path: '/settings/agents'},
    beforeEach: () => {
        mockState.settings.agentsEnabled = true
    },
}
