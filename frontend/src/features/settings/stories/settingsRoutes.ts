import {createElement, type ReactNode} from 'react'
import type {RouteObject} from 'react-router-dom'
import {SettingsSubpage} from '../pages/SettingsSubpage'

/**
 * The routes Settings' stories and tests render in: `element` (the page, or
 * a part of it) at `/settings`, the pages inside Settings, and a Meetings
 * stand-in to navigate to. A route #117 adds goes here once, for both.
 */
export function settingsRoutes(element: ReactNode): RouteObject[] {
    return [
        {path: '/', element: createElement('h1', null, 'Meetings')},
        {path: '/settings', element},
        {path: '/settings/:page', element: createElement(SettingsSubpage)},
    ]
}
