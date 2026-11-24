import type {ReactNode} from 'react'
import {screen} from '@testing-library/react'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {RecordBarContext} from './recordBar'
import {Screen} from './Screen'

// Stands in for the recording's bar, which the shell provides.
const fakeRecordBar = (idle: boolean) => <div role="group" aria-label={idle ? 'Record' : 'Recording'}/>

function renderScreen(element: ReactNode, {withBar = true} = {}) {
    const router = createMemoryRouter([{path: '/', element}])
    const page = <RouterProvider router={router}/>
    return renderUi(withBar ? <RecordBarContext value={fakeRecordBar}>{page}</RecordBarContext> : page)
}

describe('Screen', () => {
    it('tells the recording bar whether the screen docks it while idle', () => {
        renderScreen(<Screen recordBar><h1>Meetings</h1></Screen>)
        expect(screen.getByRole('group', {name: 'Record'})).toBeInTheDocument()
    })

    it('docks the recording bar above the screen’s own bar', () => {
        renderScreen(<Screen bar={<div role="group" aria-label="Playback"/>}><h1>Meeting</h1></Screen>)
        const bars = screen.getAllByRole('group')
        expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual(['Recording', 'Playback'])
    })

    it('hides an empty footer from screen readers', () => {
        renderScreen(<Screen><h1>Settings</h1></Screen>, {withBar: false})
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
    })
})
