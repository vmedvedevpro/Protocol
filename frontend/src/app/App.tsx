import {IconContext} from '@phosphor-icons/react'
import {BrowserRouter, Navigate, Route, Routes} from 'react-router-dom'
import {ICON_DEFAULTS} from '@/styles/icons'
import {AppThemeProvider} from './AppThemeProvider'
import {MinibarPlaceholder} from './placeholder/MinibarPlaceholder'
import {ShellPlaceholder} from './placeholder/ShellPlaceholder'
import {useUpdaterStatusSync} from './useUpdaterStatusSync'

export function App() {
    useUpdaterStatusSync()

    return (
        <AppThemeProvider>
            <IconContext.Provider value={ICON_DEFAULTS}>
                <BrowserRouter>
                    <Routes>
                        <Route index element={<ShellPlaceholder/>}/>
                        {/* minibar.rs opens this route in its own window. */}
                        <Route path="/minibar" element={<MinibarPlaceholder/>}/>
                        <Route path="*" element={<Navigate to="/" replace/>}/>
                    </Routes>
                </BrowserRouter>
            </IconContext.Provider>
        </AppThemeProvider>
    )
}
