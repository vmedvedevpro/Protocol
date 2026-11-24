import {act, screen} from '@testing-library/react'
import {MemoryRouter} from 'react-router-dom'
import {describe, expect, it} from 'vitest'
import {recordingPhase} from '@/api/recordingPhase'
import {renderUi} from '@/test/renderUi'
import {RecordingBar} from './RecordingBar'

const renderBar = (idle: boolean) => renderUi(<MemoryRouter><RecordingBar idle={idle}/></MemoryRouter>)

describe('RecordingBar', () => {
    it('shows Record while idle only where the screen docks it', () => {
        const {rerender} = renderBar(true)
        expect(screen.getByRole('group', {name: 'Record'})).toHaveTextContent('Ready to record')
        expect(screen.getByRole('button', {name: /Record/})).toBeInTheDocument()

        rerender(<MemoryRouter><RecordingBar idle={false}/></MemoryRouter>)
        expect(screen.queryByRole('group')).not.toBeInTheDocument()
    })

    it('shows on every screen while a recording runs', () => {
        renderBar(false)
        act(() => recordingPhase.set('recording'))
        expect(screen.getByRole('group', {name: 'Recording'})).toBeInTheDocument()
    })
})
