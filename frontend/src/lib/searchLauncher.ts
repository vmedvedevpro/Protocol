import {create} from 'zustand'

/**
 * Whether search and commands (⌘K, `features/search`) is open, and the
 * query in its field. The dialog is mounted once by the shell; ⌘K opens it
 * empty, and Home's search field opens it with what the user typed there.
 */
interface SearchLauncher {
    open: boolean
    query: string
}

export const useSearchLauncher = create<SearchLauncher>(() => ({open: false, query: ''}))

export const openSearch = (query = '') => useSearchLauncher.setState({open: true, query})

export const closeSearch = () => useSearchLauncher.setState({open: false, query: ''})
