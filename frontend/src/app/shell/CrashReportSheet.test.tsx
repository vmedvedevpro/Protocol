import {QueryClientProvider} from '@tanstack/react-query'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {createTestQueryClient} from '@/test/queryClient'
import {renderUi} from '@/test/renderUi'
import {CrashReportSheet} from './CrashReportSheet'

const PANIC = {
    reportId: '0123456789abcdef',
    detectedAt: '2026-11-23T18:30:00Z',
    crashType: 'panic',
    appVersion: '0.6.0',
} as const

function renderSheet() {
    renderUi(
        <QueryClientProvider client={createTestQueryClient()}>
            <CrashReportSheet/>
        </QueryClientProvider>,
    )
}

describe('CrashReportSheet', () => {
    it("shows what's included under its disclosure and hides it again", async () => {
        mockState.crashReport = PANIC
        renderSheet()

        const disclosure = await screen.findByRole('button', {name: "What's included?"})
        expect(screen.queryByText(/No audio, recordings/)).not.toBeInTheDocument()

        await userEvent.click(disclosure)
        expect(disclosure).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText(/No audio, recordings/)).toBeInTheDocument()

        await userEvent.click(disclosure)
        expect(disclosure).toHaveAttribute('aria-expanded', 'false')
        await waitFor(() => expect(screen.queryByText(/No audio, recordings/)).not.toBeInTheDocument())
    })

    it('dismisses a sent report whose browser did not open, so no second ZIP is written', async () => {
        mockState.crashReport = PANIC
        // As open_external_url does when ShellExecuteW or xdg-open fails.
        vi.spyOn(handlers, 'open_external_url').mockImplementation(() => {
            throw 'Failed to open the link'
        })
        renderSheet()

        await userEvent.click(await screen.findByRole('button', {name: 'Send Report'}))

        expect(await screen.findByRole('alert')).toHaveTextContent("The ZIP is saved, but the browser didn't open.")
        expect(mockState.crashReportZips).toEqual(['/home/user/Protocol-crash.zip'])
        expect(mockState.crashReport).toBeNull()
        expect(screen.queryByRole('button', {name: 'Send Report'})).not.toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', {name: 'Done'}))
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    })
})
