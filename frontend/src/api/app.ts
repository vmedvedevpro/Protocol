import {queryOptions} from '@tanstack/react-query'
import {command} from './core'

export const appKeys = {
    all: ['app'] as const,
    version: () => [...appKeys.all, 'version'] as const,
    dataFolder: () => [...appKeys.all, 'dataFolder'] as const,
}

/** The version in tauri.conf.json, through Tauri's app plugin (`getVersion`). */
export const getAppVersion = () => command<string>('plugin:app|version')

export const appVersionQuery = queryOptions({
    queryKey: appKeys.version(),
    queryFn: getAppVersion,
    // Fixed for the life of the process.
    staleTime: Infinity,
})

/**
 * The app's data folder (`paths::install_data_root`, database/commands.rs):
 * the meetings database and the models. Recordings are not here: they go to
 * the recordings folder (`audio/recording_preferences.rs`, Settings ›
 * Recording). Recording builds the stop's save path from it; Settings shows it.
 */
export const getDatabaseDirectory = () => command<string>('get_database_directory')

export const dataFolderQuery = queryOptions({
    queryKey: appKeys.dataFolder(),
    queryFn: getDatabaseDirectory,
    // Resolved once when the app starts.
    staleTime: Infinity,
})

/** Opens the data folder in the file manager, creating it first if it is missing. */
export const openDataFolder = () => command<null>('open_database_folder')
