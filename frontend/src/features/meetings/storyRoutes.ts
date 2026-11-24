import {createElement} from 'react'
import type {RouteObject} from 'react-router-dom'
import {HomeScreen} from './home/HomeScreen'
import {MeetingRoute} from './meeting/MeetingScreen'

/**
 * The routes the meetings stories render in: Home and the meeting screen,
 * so a row opens its meeting and Back returns, and a stand-in for the
 * screens other tasks own (Settings, Recording).
 */
export function meetingsStoryRoutes(): RouteObject[] {
    return [
        {path: '/', element: createElement(HomeScreen)},
        {path: '/meetings/:meetingId', element: createElement(MeetingRoute)},
        {path: '*', element: createElement('h1', null, 'Another screen')},
    ]
}
