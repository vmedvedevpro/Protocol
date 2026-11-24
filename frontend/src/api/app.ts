import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

export const appKeys = {
    all: ['app'] as const,
    version: () => [...appKeys.all, 'version'] as const,
}

/** The version in tauri.conf.json, through Tauri's app plugin (`getVersion`). */
export const getAppVersion = () => command<string>('plugin:app|version')

export const appVersionQuery = queryOptions({
    queryKey: appKeys.version(),
    queryFn: getAppVersion,
    // Fixed for the life of the process.
    staleTime: Infinity,
})
