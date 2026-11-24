import '@testing-library/jest-dom/vitest'
import {cleanup} from '@testing-library/react'
import {clearMocks} from '@tauri-apps/api/mocks'
import {MotionGlobalConfig} from 'motion/react'
import {afterEach, beforeEach} from 'vitest'
import {postCallJobs} from '@/api/postCall'
import {rereadPreferences} from '@/api/preferences'
import {recordingPhase} from '@/api/recordingPhase'
import {useKeepOnTopStore} from '@/app/shell/keepOnTop'
import {useAdvancedSettingsStore} from '@/features/settings/store/advanced'
import {resetToasts} from '@/components/ui/toastStore'
import {installMockIpc} from '@/mocks/ipc'
import {resetMockState} from '@/mocks/state'
import {useThemeModeStore} from '@/styles/themeMode'
import {installMatchMedia} from './matchMedia'

// Animations jump to their end, so a test sees the final state at once.
MotionGlobalConfig.skipAnimations = true

// jsdom has no pointer capture, and Radix's toasts, in every renderUi tree
// through UiProviders, release it on each pointerup inside a toast.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}

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
    useAdvancedSettingsStore.setState({advanced: false})
    resetToasts()
    postCallJobs.reset()
    recordingPhase.set('idle')
    // Tests that fake View Transitions install the method on document.
    delete (document as { startViewTransition?: unknown }).startViewTransition
    localStorage.clear()
    // The stored preferences go back to their defaults with the storage.
    rereadPreferences(null)
    window.history.replaceState(null, '', '/')
})
