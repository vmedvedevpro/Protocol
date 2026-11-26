import type {ReactNode} from 'react'
import {useUpdaterStatusSync} from '@/api/updater'
import {StoryWindow} from '@/components/screen/StoryWindow'
import {settingsRoutes} from './settingsRoutes'

interface SettingsStoryWindowProps {
    /** Where the window opens, `/settings?section=recording` for one. */
    path?: string
    /** What `/settings` shows: the Settings page, or a part of it. */
    children: ReactNode
    /** The window's width, `460px` as it opens. */
    width?: string
}

/**
 * A Settings story in the app's window, with Settings' routes and what App
 * mounts for Settings: the updater snapshot kept current from its event.
 */
export function SettingsStoryWindow({path = '/settings', children, width}: SettingsStoryWindowProps) {
    useUpdaterStatusSync()
    return <StoryWindow routes={settingsRoutes(children)} url={path} width={width}/>
}
