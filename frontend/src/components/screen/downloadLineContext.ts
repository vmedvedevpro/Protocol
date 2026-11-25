import {createContext} from 'react'

/**
 * Whether screens show the status line of model downloads in their footer.
 * The shell turns it on once first launch is done: first launch shows its
 * own list, and a click on the line opens Settings. Without a provider, as
 * in a story or a test of a screen, none shows.
 */
export const DownloadLineContext = createContext(false)
