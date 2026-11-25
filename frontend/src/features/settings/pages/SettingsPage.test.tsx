import {createElement} from 'react'
import {act, screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it} from 'vitest'
import {MEETING_LANGUAGE_KEY, rereadPreferences, USER_NAME_KEY} from '@/api/preferences'
import {recordingPhase} from '@/api/recordingPhase'
import {renderSettings} from '../testing'
import {SETTINGS_ADVANCED_KEY, useAdvancedSettingsStore} from '../store/advanced'
import {SettingsPage} from './SettingsPage'

const renderPage = (path?: string) => renderSettings(createElement(SettingsPage), path)
const heading = (name: string) => screen.findByRole('heading', {level: 1, name})
const group = (name: string) => screen.getByRole('region', {name})
const tab = (name: string) => screen.getByRole('tab', {name})

describe('Settings, simple', () => {
    it('shows what most people need and keeps the rest behind Advanced', async () => {
        renderPage()
        await heading('Settings')

        expect(within(group('You')).getByRole('textbox', {name: 'Your name'})).toBeInTheDocument()
        expect(within(group('You')).getByRole('radiogroup', {name: 'Theme'})).toBeInTheDocument()
        expect(within(group('Recording')).getByRole('combobox', {name: 'Microphone'})).toBeInTheDocument()
        expect(within(group('Recording')).getByRole('combobox', {name: 'Meeting language'})).toBeInTheDocument()
        expect(within(group('Summaries')).getByRole('switch', {name: 'Summarize automatically'})).toBeChecked()
        expect(await within(group('Summaries')).findByRole('button', {name: /Summary model.*Built-in · Qwen 3.5 4B/}))
            .toBeInTheDocument()
        expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    })

    it('keeps the name under its old key', async () => {
        renderPage()
        await userEvent.type(await screen.findByRole('textbox', {name: 'Your name'}), 'Tyler')

        expect(localStorage.getItem(USER_NAME_KEY)).toBe('Tyler')
    })

    it('locks the meeting language from Record until the meeting is saved', async () => {
        localStorage.setItem(MEETING_LANGUAGE_KEY, 'ru')
        rereadPreferences(MEETING_LANGUAGE_KEY)
        renderPage()
        const language = await screen.findByRole('combobox', {name: 'Meeting language'})
        expect(language).toHaveTextContent('Russian')
        expect(language).toBeEnabled()

        act(() => recordingPhase.set('starting'))
        expect(language).toBeDisabled()
        expect(screen.getByText('Can’t change during a recording')).toBeInTheDocument()

        act(() => recordingPhase.set('idle'))
        expect(language).toBeEnabled()
    })

    it('opens every section from More settings and remembers it', async () => {
        renderPage()
        await userEvent.click(await screen.findByRole('button', {name: /More settings/}))

        expect(await screen.findByRole('tablist', {name: 'Settings sections'})).toBeInTheDocument()
        expect(tab('General')).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByRole('switch', {name: 'Advanced settings'})).toBeChecked()
        expect(JSON.parse(localStorage.getItem(SETTINGS_ADVANCED_KEY) ?? '{}')).toMatchObject({state: {advanced: true}})
    })
})

describe('Settings, advanced', () => {
    it('keeps the section in the URL', async () => {
        useAdvancedSettingsStore.setState({advanced: true})
        const {router} = renderPage()
        await heading('Settings')

        await userEvent.click(tab('Recording'))

        expect(router.state.location.search).toBe('?section=recording')
        expect(await screen.findByRole('region', {name: 'Saving'})).toBeInTheDocument()
    })

    it('opens an old section id with Advanced on', async () => {
        renderPage('/settings?section=transcription')

        expect(await screen.findByRole('tab', {name: 'AI', selected: true})).toBeInTheDocument()
        expect(useAdvancedSettingsStore.getState().advanced).toBe(true)
    })

    it('lands the tray’s About on Updates, then forgets it', async () => {
        const {router} = renderPage('/settings?section=about')

        expect(await screen.findByRole('tab', {name: 'General', selected: true})).toBeInTheDocument()
        expect(screen.getByRole('region', {name: 'Updates'})).toBeInTheDocument()
        await waitFor(() => expect(router.state.location.search).toBe('?section=general'))
    })

    it('goes back to the simple page and drops the section', async () => {
        const {router} = renderPage('/settings?section=recording')
        const advanced = await screen.findByRole('switch', {name: 'Advanced settings'})
        await waitFor(() => expect(advanced).toBeChecked())

        await userEvent.click(advanced)

        await waitFor(() => expect(screen.queryByRole('tablist')).not.toBeInTheDocument())
        expect(router.state.location.search).toBe('')
        expect(group('Summaries')).toBeInTheDocument()
    })
})

describe('Settings pages', () => {
    it('opens the summary model page and comes back to where it was opened', async () => {
        const {router} = renderPage()
        await userEvent.click(await screen.findByRole('button', {name: /Summary model/}))

        await heading('Summary model')
        await userEvent.click(screen.getByRole('button', {name: 'Back to Settings'}))

        expect(router.state.location.pathname).toBe('/settings')
    })

    it('goes back to the page’s section with Advanced on', async () => {
        useAdvancedSettingsStore.setState({advanced: true})
        const {router} = renderPage('/settings/chosen-apps')

        await heading('Chosen apps')
        await userEvent.click(screen.getByRole('button', {name: 'Back to Recording'}))

        expect(`${router.state.location.pathname}${router.state.location.search}`).toBe('/settings?section=recording')
    })

    it('sends an unknown page to Settings', async () => {
        const {router} = renderPage('/settings/nothing')

        await heading('Settings')
        expect(router.state.location.pathname).toBe('/settings')
    })
})
