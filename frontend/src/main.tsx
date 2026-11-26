import './styles/fonts'
import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {QueryClientProvider} from '@tanstack/react-query'
import {App} from './app/App'
import {isTauri} from './api/core'
import {installErrorLogging} from './api/logs'
import {queryClient} from './lib/queryClient'

async function start() {
    // In a plain browser (`pnpm dev`) every command and event goes to the
    // in-memory mock. Production builds drop this branch and the mock chunk.
    if (import.meta.env.DEV && !isTauri()) {
        const {installMockIpc} = await import('./mocks/ipc')
        installMockIpc()
    }
    // From here on the window's uncaught errors reach the native log.
    installErrorLogging()

    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <QueryClientProvider client={queryClient}>
                <App/>
            </QueryClientProvider>
        </StrictMode>,
    )
}

void start()
