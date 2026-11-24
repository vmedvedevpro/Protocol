import {act, render, screen} from '@testing-library/react'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {ThemeProvider} from 'styled-components'
import {describe, expect, it} from 'vitest'
import {recordingPhase} from '@/api/recordingPhase'
import {UiProviders} from '@/app/UiProviders'
import {lightTheme} from '@/styles/theme'
import {Screen} from './Screen'

function renderScreen(element: React.ReactNode) {
    const router = createMemoryRouter([{path: '/', element}])
    return render(
        <ThemeProvider theme={lightTheme}>
            <UiProviders>
                <RouterProvider router={router}/>
            </UiProviders>
        </ThemeProvider>,
    )
}

describe('Screen', () => {
    it('docks the idle recording bar only where the screen asks for it', () => {
        renderScreen(<Screen recordBar><h1>Meetings</h1></Screen>)
        expect(screen.getByRole('group', {name: 'Record'})).toHaveTextContent('Ready to record')
        expect(screen.getByRole('button', {name: /Record/})).toBeInTheDocument()
    })

    it('hides an empty footer from screen readers', () => {
        renderScreen(<Screen><h1>Settings</h1></Screen>)
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    })

    it('docks the recording bar on every screen while a recording runs, above the screen’s own bar', () => {
        renderScreen(<Screen bar={<div role="group" aria-label="Playback"/>}><h1>Meeting</h1></Screen>)
        expect(screen.queryByRole('group', {name: 'Recording'})).not.toBeInTheDocument()

        act(() => recordingPhase.set('recording'))
        const bars = screen.getAllByRole('group')
        expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual(['Recording', 'Playback'])
    })
})
