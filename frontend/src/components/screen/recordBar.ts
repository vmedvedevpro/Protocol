import {createContext, type ReactNode} from 'react'

/**
 * Renders the recording bar a screen docks; `idle` says whether the screen
 * docks it while nothing records (`ScreenProps.recordBar`).
 */
export type RenderRecordBar = (idle: boolean) => ReactNode

/**
 * The recording bar a screen docks: the shell provides the recording's
 * (`features/recording`), so nothing under `components/` imports a feature.
 * Without a provider, as in a story or a test of a screen, none is docked.
 */
export const RecordBarContext = createContext<RenderRecordBar | null>(null)
