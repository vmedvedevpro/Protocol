import type {ReactNode} from 'react'
import {screen} from '@testing-library/react'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {RecordBarContext} from './recordBar'
import {Screen} from './Screen'

// Stands in for the recording's bar, which the shell provides: idle, it
// shows only where the screen docks it.
const fakeRecordBar = (idle: boolean) => idle && <div role="group" aria-label="Record"/>

function renderScreen(element: ReactNode) {
    const router = createMemoryRouter([{path: '/', element}])
    return renderUi(<RecordBarContext value={fakeRecordBar}><RouterProvider router={router}/></RecordBarContext>)
}

describe('Screen', () => {
    it('docks the recording bar above the screen’s own bar', () => {
        renderScreen(<Screen recordBar bar={<div role="group" aria-label="Playback"/>}><h1>Meetings</h1></Screen>)
        const bars = screen.getAllByRole('group')
        expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual(['Record', 'Playback'])
    })

    it('hides an empty footer from screen readers', () => {
        renderScreen(<Screen><h1>Settings</h1></Screen>)
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    })
})
