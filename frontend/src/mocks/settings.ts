import type {AddedExtension, AgentAccess} from '@/features/settings/api/agents'
import type {RecordableApp} from '@/features/settings/api/apps'
import type {Platform} from '@/lib/platform'
import type {MockHandler} from './handlers'

/**
 * What only Settings asks native: AI agents' access and Claude Desktop
 * (agent_access.rs, claude_desktop_extension.rs), the running apps and the
 * app picker (recording_preferences.rs), and opening the data folder
 * (database/commands.rs). Ported from `162e8be:frontend/src/dev/preview/index.ts`.
 */
export interface MockSettings {
    agentsEnabled: boolean
    /** The server program is there (false: a development build without it). */
    serverFound: boolean
    /** macOS ran the app from a translocated copy. */
    translocated: boolean
    /** The extension added before points at a server this app no longer has. */
    extensionMoved: boolean
    /** What `add_to_claude_desktop` answers: null opens Claude Desktop, a string fails to. */
    claudeDesktopOpenError: string | null
    /** Running now; a test empties it or names one playing sound. */
    runningApps: RecordableApp[]
    /** What the app picker answers; null: the user cancelled. */
    pickedApp: RecordableApp | null
    /** How often the data folder was opened. */
    dataFolderOpened: number
}

const RUNNING_APPS: RecordableApp[] = [
    {id: 'Zoom.exe', name: 'Zoom Workplace', executable: 'Zoom.exe', pid: 4120, has_audio: true, icon: null},
    {id: 'chrome.exe', name: 'Google Chrome', executable: 'chrome.exe', pid: 9876, has_audio: true, icon: null},
    {id: 'Spotify.exe', name: 'Spotify', executable: 'Spotify.exe', pid: 7312, has_audio: true, icon: null},
    {id: 'ms-teams.exe', name: 'Microsoft Teams', executable: 'ms-teams.exe', pid: 5544, has_audio: false, icon: null},
    {id: 'slack.exe', name: 'Slack', executable: 'slack.exe', pid: 6620, has_audio: false, icon: null},
    {id: 'Discord.exe', name: 'Discord', executable: 'Discord.exe', pid: 8210, has_audio: false, icon: null},
    {id: 'Code.exe', name: 'Visual Studio Code', executable: 'Code.exe', pid: 3108, has_audio: false, icon: null},
]

export function createMockSettings(): MockSettings {
    return {
        agentsEnabled: false,
        serverFound: true,
        translocated: false,
        extensionMoved: false,
        claudeDesktopOpenError: null,
        runningApps: structuredClone(RUNNING_APPS),
        pickedApp: {id: 'CiscoCollabHost.exe', name: 'Webex', executable: 'CiscoCollabHost.exe', pid: null, has_audio: false, icon: null},
        dataFolderOpened: 0,
    }
}

/** The install each platform's mock pretends to be. */
function serverPath(platform: Platform) {
    if (platform === 'windows') return 'C:\\Users\\Tyler\\AppData\\Local\\vmedvedevpro\\Protocol\\protocol-mcp.exe'
    if (platform === 'macos') return '/Applications/Protocol.app/Contents/MacOS/protocol-mcp'
    return '/usr/bin/protocol-mcp'
}

export function settingsHandlers(state: {settings: MockSettings, platform: Platform}): Record<string, MockHandler> {
    const access = (): AgentAccess => {
        const server = serverPath(state.platform)
        return {
            enabled: state.settings.agentsEnabled,
            databasePath: state.platform === 'windows'
                ? 'C:\\Users\\Tyler\\AppData\\Local\\vmedvedevpro\\Protocol\\data\\meeting_minutes.sqlite'
                : '/home/user/.local/share/protocol/meeting_minutes.sqlite',
            command: server,
            args: ['--mcp-server'],
            serverFound: state.settings.serverFound,
            translocated: state.settings.translocated,
            claudeCodeCommand: `claude mcp add --scope user protocol -- "${server}" --mcp-server`,
            claudeDesktopConfig: JSON.stringify({mcpServers: {protocol: {command: server, args: ['--mcp-server']}}}, null, 2),
            extensionSupported: state.platform !== 'linux',
            extensionMoved: state.settings.extensionMoved,
        }
    }
    return {
        get_agent_access: access,
        set_agent_access: ({enabled}) => {
            state.settings.agentsEnabled = enabled === true
            return access()
        },
        add_to_claude_desktop: (): AddedExtension => {
            if (state.platform === 'linux') throw 'Claude Desktop runs on Windows and macOS only.'
            if (!state.settings.agentsEnabled) throw 'Turn on access for AI agents first.'
            state.settings.extensionMoved = false
            const error = state.settings.claudeDesktopOpenError
            return {
                bundle: state.platform === 'windows'
                    ? 'C:\\Users\\Tyler\\AppData\\Local\\vmedvedevpro\\Protocol\\data\\mcpb\\Protocol.mcpb'
                    : '/Users/tyler/Library/Application Support/vmedvedevpro/Protocol/mcpb/Protocol.mcpb',
                opened: error === null,
                openError: error,
            }
        },
        // Native walks every process on a blocking thread.
        get_recordable_apps: () => new Promise((resolve) => setTimeout(() => resolve(structuredClone(state.settings.runningApps)), 50)),
        select_custom_app_executable: () => structuredClone(state.settings.pickedApp),
        open_database_folder: () => {
            state.settings.dataFolderOpened++
            return null
        },
    }
}
