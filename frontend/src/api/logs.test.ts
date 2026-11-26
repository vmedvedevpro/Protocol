import {waitFor} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {installErrorLogging} from './logs'

describe('installErrorLogging', () => {
    it('writes uncaught errors and unhandled rejections to the log until removed', async () => {
        const remove = installErrorLogging()
        window.dispatchEvent(new ErrorEvent('error', {error: new Error('boom'), message: 'boom'}))
        const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
        Object.defineProperty(rejection, 'reason', {value: 'the summary request failed'})
        window.dispatchEvent(rejection)
        await waitFor(() => expect(mockState.logs.webViewErrors).toEqual([
            {kind: 'error', message: 'boom'},
            {kind: 'unhandled rejection', message: 'the summary request failed'},
        ]))

        remove()
        window.dispatchEvent(new ErrorEvent('error', {message: 'after removal'}))
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(mockState.logs.webViewErrors).toHaveLength(2)
    })
})
