import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom'
import {AppThemeProvider} from './AppThemeProvider'
import {MinibarPlaceholder} from './placeholder/MinibarPlaceholder'
import {ShellPlaceholder} from './placeholder/ShellPlaceholder'
import {UiProviders} from './UiProviders'
import {useUpdaterStatusSync} from './useUpdaterStatusSync'

export function App() {
    useUpdaterStatusSync()

    return (
        <AppThemeProvider>
            <UiProviders>
                <BrowserRouter>
                    <Routes>
                        <Route index element={<ShellPlaceholder/>}/>
                        {/* minibar.rs opens this route in its own window. */}
                        <Route path="/minibar" element={<MinibarPlaceholder/>}/>
                        <Route path="*" element={<Navigate to="/" replace/>}/>
                    </Routes>
                </BrowserRouter>
            </UiProviders>
        </AppThemeProvider>
    )
}
