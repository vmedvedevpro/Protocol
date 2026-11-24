import '@testing-library/jest-dom/vitest'
import {cleanup} from '@testing-library/react'
import {clearMocks} from '@tauri-apps/api/mocks'
import {MotionGlobalConfig} from 'motion/react'
import {afterEach, beforeEach} from 'vitest'
import {useKeepOnTopStore} from '@/app/shell/keepOnTop'
import {installMockIpc} from '@/mocks/ipc'
import {resetMockState} from '@/mocks/state'
import {useThemeModeStore} from '@/styles/themeMode'
import {installMatchMedia} from './matchMedia'

// Animations jump to their end, so a test sees the final state at once.
MotionGlobalConfig.skipAnimations = true

// Every test runs on the same mock IPC as the browser, from a fresh state.
beforeEach(() => {
    installMatchMedia()
    resetMockState()
    installMockIpc()
})

afterEach(() => {
    cleanup()
    clearMocks()
    useThemeModeStore.setState({mode: 'system'})
    useKeepOnTopStore.setState({onTop: false})
    // Tests that fake View Transitions install the method on document.
    delete (document as { startViewTransition?: unknown }).startViewTransition
    localStorage.clear()
    window.history.replaceState(null, '', '/')
})
