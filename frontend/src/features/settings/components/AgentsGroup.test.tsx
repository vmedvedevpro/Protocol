import {createElement} from 'react'
import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {Platform} from '@/lib/platform'
import {mockState} from '@/mocks/state'
import {SettingsPage} from '../pages/SettingsPage'
import {indexedLabels} from '../pages/settingsPages'
import {renderedRowLabels, renderSettings} from '../testing'

const openAdvanced = () => renderSettings(createElement(SettingsPage), '/settings?section=advanced')
const openPage = (platform: Platform = 'windows') => {
    mockState.platform = platform
    mockState.settings.agentsEnabled = true
    return renderSettings(createElement(SettingsPage), '/settings/agents')
}

describe('AI agents', () => {
    it('lets agents read the meetings and offers to connect them', async () => {
        const {router} = openAdvanced()
        const group = await screen.findByRole('region', {name: 'AI agents'})
        const toggle = within(group).getByRole('switch', {name: 'Let AI agents read your meetings'})
        await waitFor(() => expect(toggle).toBeEnabled())
        expect(within(group).queryByRole('button', {name: /Connect Claude Code/})).not.toBeInTheDocument()

        await userEvent.click(toggle)
        await waitFor(() => expect(mockState.settings.agentsEnabled).toBe(true))
        await userEvent.click(await within(group).findByRole('button', {name: /Connect Claude Code/}))
        expect(router.state.location.pathname).toBe('/settings/agents')
    })

    it('can’t be turned on without the server', async () => {
        mockState.settings.serverFound = false
        openAdvanced()
        expect(await screen.findByText(/This build doesn’t include the server/)).toBeInTheDocument()
        expect(screen.getByRole('switch', {name: 'Let AI agents read your meetings'})).toBeDisabled()
    })

    it('shows the data folder and opens it', async () => {
        openAdvanced()
        expect(await screen.findByText(/Meetings database and models · \/home\/user\/.local\/share\/protocol/)).toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Show folder'}))
        await waitFor(() => expect(mockState.settings.dataFolderOpened).toBe(1))
    })
})

describe('Connect an agent', () => {
    it('copies Claude Code’s command', async () => {
        const writeText = vi.fn(() => Promise.resolve())
        Object.defineProperty(navigator, 'clipboard', {value: {writeText}, configurable: true})
        openPage()
        const command = await screen.findByLabelText('Claude Code command')
        expect(command).toHaveTextContent('claude mcp add --scope user protocol')

        await userEvent.click(within(await screen.findByRole('region', {name: 'Claude Code'})).getByRole('button', {name: 'Copy'}))
        expect(writeText).toHaveBeenCalledWith(command.textContent)
    })

    it('adds Protocol to Claude Desktop, and opens the setup by hand when it can’t', async () => {
        mockState.settings.claudeDesktopOpenError = 'No application knows .mcpb files'
        openPage('windows')
        await userEvent.click(await screen.findByRole('button', {name: 'Add'}))

        expect(await screen.findByText('No application knows .mcpb files')).toBeInTheDocument()
        expect(await screen.findByLabelText('Claude Desktop configuration')).toHaveTextContent('"mcpServers"')
    })

    it('gives Linux the configuration to paste', async () => {
        openPage('linux')
        expect(await screen.findByLabelText('Claude Desktop configuration')).toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'Add'})).not.toBeInTheDocument()
    })

    it('turns access on first', async () => {
        mockState.platform = 'windows'
        renderSettings(createElement(SettingsPage), '/settings/agents')
        await userEvent.click(await screen.findByRole('button', {name: 'Turn on'}))
        expect(await screen.findByLabelText('Claude Code command')).toBeInTheDocument()
    })

    it('shows the rows its search index lists', async () => {
        openPage('windows')
        await userEvent.click(await screen.findByRole('button', {name: 'Show'}))
        await screen.findByLabelText('Claude Desktop configuration')
        expect(renderedRowLabels()).toEqual([...indexedLabels('agents')].sort())
    })
})
