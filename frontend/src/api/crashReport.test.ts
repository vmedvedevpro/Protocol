import {describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {chooseCrashReportDestination, type PendingCrashReport} from './crashReport'

const REPORT: PendingCrashReport = {
    reportId: '0123456789abcdef',
    detectedAt: '2026-11-23T18:30:00Z',
    crashType: 'panic',
    appVersion: '0.6.0',
}

describe('chooseCrashReportDestination', () => {
    it('asks again with .zip added when the dialog returns a name without it', async () => {
        // A GTK dialog returns the name as typed; the second answer keeps `.zip`.
        const answers = ['/home/user/report', '/home/user/report.zip']
        const save = vi.spyOn(handlers, 'plugin:dialog|save').mockImplementation(() => answers.shift())

        await expect(chooseCrashReportDestination(REPORT)).resolves.toBe('/home/user/report.zip')
        expect(save).toHaveBeenCalledTimes(2)
        expect(save.mock.calls[0][0]).toMatchObject({options: {defaultPath: 'Protocol-crash-01234567.zip'}})
        expect(save.mock.calls[1][0]).toMatchObject({options: {defaultPath: '/home/user/report.zip'}})
    })

    it('returns null when the user cancels', async () => {
        vi.spyOn(handlers, 'plugin:dialog|save').mockReturnValue(null)

        await expect(chooseCrashReportDestination(REPORT)).resolves.toBeNull()
    })
})
