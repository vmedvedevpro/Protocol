import {createElement} from 'react'
import {screen, waitFor} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {createMemoryRouter, RouterProvider} from 'react-router-dom'
import {describe, expect, it, vi} from 'vitest'
import {mockState} from '@/mocks/state'
import {renderUi} from '@/test/renderUi'
import {MinibarError, RouteError} from './RouteError'

function Broken(): never {
    throw new Error('Cannot read properties of undefined (reading "title")')
}

function BrokenBar(): never {
    throw new Error('the timer failed')
}

describe('RouteError', () => {
    it('shows a screen that threw, logs it and goes back to the meetings', async () => {
        // React logs the caught render error itself; keep the output clean.
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const router = createMemoryRouter([
            {path: '/', element: createElement('p', null, 'Meetings')},
            {path: '/broken', element: createElement(Broken), errorElement: createElement(RouteError)},
        ], {initialEntries: ['/broken']})
        renderUi(createElement(RouterProvider, {router}))

        expect(await screen.findByRole('heading', {level: 1, name: 'Something went wrong'})).toBeInTheDocument()
        expect(screen.getByRole('alert')).toHaveFocus()
        expect(screen.getByText(/reading "title"/)).toBeInTheDocument()
        expect(screen.getByText(/use Save logs in Settings › Advanced/)).toBeInTheDocument()
        await waitFor(() => expect(mockState.logs.webViewErrors).toEqual([
            {kind: 'screen error', message: 'Cannot read properties of undefined (reading "title")'},
        ]))

        await userEvent.click(screen.getByRole('button', {name: 'Back to meetings'}))
        expect(await screen.findByText('Meetings')).toBeInTheDocument()
    })

    it('shows the minibar\'s own short error with Reload only', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
        const router = createMemoryRouter([
            {path: '/minibar', element: createElement(BrokenBar), errorElement: createElement(MinibarError)},
        ], {initialEntries: ['/minibar']})
        renderUi(createElement(RouterProvider, {router}))

        expect(await screen.findByRole('alert')).toHaveTextContent('The bar stopped working')
        expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Reload'])
        await waitFor(() => expect(mockState.logs.webViewErrors).toEqual([{kind: 'screen error', message: 'the timer failed'}]))
    })
})
