import {screen, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {postCallJobs, registerPostCallControls} from '@/api/postCall'
import {renderUi} from '@/test/renderUi'
import {ProcessingLine} from './ProcessingLine'
import {ProcessingStatus} from './ProcessingStatus'
import {ProcessingSteps} from './ProcessingSteps'

function runner() {
    const controls = {cancel: vi.fn(), retry: vi.fn(), skip: vi.fn()}
    registerPostCallControls(controls)
    return controls
}

describe('ProcessingStatus', () => {
    it('shows nothing without a pass', () => {
        const {container} = renderUi(<ProcessingStatus meetingId="m1"/>)
        // The providers may draw their own empty regions (the toaster).
        expect(container.textContent).toBe('')
        expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
    })

    it('says what runs, how long is left and how far the pass has got', async () => {
        const controls = runner()
        postCallJobs.queue('m1', ['transcript', 'speakers', 'summary'])
        postCallJobs.run('m1', 'transcript', Date.now() - 40_000)
        postCallJobs.progress('m1', 25)
        renderUi(<ProcessingStatus meetingId="m1"/>)

        expect(screen.getByRole('status')).toHaveTextContent('Improving the transcript')
        expect(screen.getByText('· about 2 min')).toBeInTheDocument()
        // Saved, plus a quarter of the first of three steps: 1.25 of 4.
        expect(screen.getByRole('progressbar', {name: 'Processing the meeting'})).toHaveAttribute('aria-valuenow', '31')

        await userEvent.click(screen.getByRole('button', {name: 'Cancel'}))
        expect(controls.cancel).toHaveBeenCalledWith('m1')
    })

    it('offers no Cancel while the pass waits for another meeting', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers'])
        renderUi(<ProcessingStatus meetingId="m1"/>)
        expect(screen.getByRole('status')).toHaveTextContent('Waiting for another meeting to finish')
        expect(screen.queryByRole('button', {name: 'Cancel'})).not.toBeInTheDocument()
    })

    it('offers Retry and Skip after a failure', async () => {
        const controls = runner()
        postCallJobs.queue('m1', ['transcript', 'speakers'])
        postCallJobs.run('m1', 'transcript')
        postCallJobs.fail('m1', 'The audio file is missing')
        renderUi(<ProcessingStatus meetingId="m1"/>)

        const alert = screen.getByRole('alert')
        expect(alert).toHaveTextContent('Could not improve the transcript')
        expect(alert).toHaveTextContent('The audio file is missing')
        await userEvent.click(screen.getByRole('button', {name: 'Keep live transcript'}))
        expect(controls.skip).toHaveBeenCalledWith('m1')
        await userEvent.click(screen.getByRole('button', {name: 'Retry'}))
        expect(controls.retry).toHaveBeenCalledWith('m1')
    })
})

describe('ProcessingSteps', () => {
    it('lists each step as done, running, failed or to do', () => {
        postCallJobs.queue('m1', ['transcript', 'speakers', 'summary'])
        postCallJobs.run('m1', 'speakers')
        const {rerender} = renderUi(<ProcessingSteps meetingId="m1"/>)

        const steps = within(screen.getByRole('list', {name: 'Processing steps'})).getAllByRole('listitem')
        expect(steps.map((step) => step.textContent)).toEqual([
            'Recording saved, done',
            'Improving the transcript, done',
            'Finding speakers, in progress',
            'Writing the summary, to do',
        ])

        postCallJobs.fail('m1', 'No speakers model')
        rerender(<ProcessingSteps meetingId="m1"/>)
        expect(screen.getAllByRole('listitem')[2]).toHaveTextContent('Could not find speakers, failed')
    })

    it('shows only the steps the meeting runs', () => {
        postCallJobs.queue('m1', ['speakers'])
        renderUi(<ProcessingSteps meetingId="m1"/>)
        expect(screen.getAllByRole('listitem').map((step) => step.textContent)).toEqual([
            'Recording saved, done',
            'Finding speakers, to do',
        ])
    })
})

describe('ProcessingLine', () => {
    it('reads as Home shows it, and goes once the pass ends', () => {
        postCallJobs.queue('m1', ['transcript'])
        postCallJobs.run('m1', 'transcript', Date.now() - 40_000)
        postCallJobs.progress('m1', 25)
        const {container, rerender} = renderUi(<ProcessingLine meetingId="m1"/>)
        expect(container).toHaveTextContent('Improving the transcript· about 2 min')

        postCallJobs.end('m1')
        rerender(<ProcessingLine meetingId="m1"/>)
        expect(container.textContent).toBe('')
    })
})
