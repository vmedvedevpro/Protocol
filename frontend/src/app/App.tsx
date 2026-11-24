import {useEffect, useState} from 'react'
import {createBrowserRouter, RouterProvider} from 'react-router-dom'
import {AppThemeProvider} from './AppThemeProvider'
import {routes} from './routes'
import {UiProviders} from './UiProviders'
import {useUpdaterStatusSync} from './useUpdaterStatusSync'

/** The webview's own menu (Reload, Inspect) stays out of a release, as in the old app. */
function useNoContextMenuInRelease() {
    useEffect(() => {
        if (!import.meta.env.PROD) return
        const block = (event: MouseEvent) => event.preventDefault()
        document.addEventListener('contextmenu', block)
        return () => document.removeEventListener('contextmenu', block)
    }, [])
}

export function App() {
    useUpdaterStatusSync()
    useNoContextMenuInRelease()
    // One router per mount, reading the location it starts at (each test
    // sets its own path first).
    const [router] = useState(() => createBrowserRouter(routes))

    return (
        <AppThemeProvider>
            <UiProviders>
                <RouterProvider router={router}/>
            </UiProviders>
        </AppThemeProvider>
    )
}
