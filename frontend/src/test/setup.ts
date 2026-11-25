import '@testing-library/jest-dom/vitest'
// IndexedDB for the recording's crash copy; each test gets an empty one.
import 'fake-indexeddb/auto'
import {IDBFactory} from 'fake-indexeddb'
import {cleanup} from '@testing-library/react'
import {clearMocks} from '@tauri-apps/api/mocks'
import {MotionGlobalConfig} from 'motion/react'
import {afterEach, beforeEach} from 'vitest'
import {DEFAULT_LABS, useLabsStore} from '@/api/labs'
import {postCallJobs} from '@/api/postCall'
import {rereadPreferences} from '@/api/preferences'
import {recordingPhase} from '@/api/recordingPhase'
import {closeSearch} from '@/lib/searchLauncher'
import {useKeepOnTopStore} from '@/app/shell/keepOnTop'
import {resetRecording} from '@/features/recording/store/reset'
import {useAdvancedSettingsStore} from '@/features/settings/store/advanced'
import {resetToasts} from '@/components/ui/toastStore'
import {resetImport} from '@/features/dialogs/import/importState'
import {resetDialogs} from '@/lib/dialogs'
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

// jsdom does not scroll: Radix Select and Settings › Updates call
// scrollIntoView.
Element.prototype.scrollIntoView ??= () => {}

// jsdom lays nothing out, so there is no size to observe: the meeting's
// title, which shows whole in a tooltip once it is cut off, never is; and
// cmdk's list (search, #118) never changes height.
globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
}

// Every test runs on the same mock IPC as the browser, from a fresh state.
beforeEach(() => {
    installMatchMedia()
    resetMockState()
    installMockIpc()
})

afterEach(async () => {
    cleanup()
    // A test that played its animations (src/test/motion.ts) ends them again.
    MotionGlobalConfig.skipAnimations = true
    // Work still pending at unmount settles after it: a listen() that resolves
    // late calls its stop() (src/api/events.ts), the audio preview's queue
    // runs its stop. Both need the mock IPC, so they get a macrotask, which
    // runs every microtask before it, while the mocks still exist.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await resetRecording()
    globalThis.indexedDB = new IDBFactory()
    clearMocks()
    useThemeModeStore.setState({mode: 'system'})
    useKeepOnTopStore.setState({onTop: false})
    useAdvancedSettingsStore.setState({advanced: false})
    useLabsStore.setState({value: DEFAULT_LABS})
    resetToasts()
    resetDialogs()
    resetImport()
    postCallJobs.reset()
    recordingPhase.set('idle')
    closeSearch()
    // Tests that fake View Transitions install the method on document.
    delete (document as { startViewTransition?: unknown }).startViewTransition
    localStorage.clear()
    // The stored preferences go back to their defaults with the storage.
    rereadPreferences(null)
    window.history.replaceState(null, '', '/')
})
