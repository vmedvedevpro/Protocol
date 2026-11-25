/**
 * AI agents reading the meetings through Protocol's MCP server
 * (src-tauri/src/agent_access.rs, claude_desktop_extension.rs): whether
 * they may, what an agent runs, and adding Protocol to Claude Desktop. The
 * switch lives in `mcp-server.json` next to the database, which the server
 * reads at every question, so turning it off needs no restart.
 */
import {mutationOptions, queryOptions} from '@tanstack/react-query'
import {command} from '@/api/core'

/** Mirrors `AgentAccess` in agent_access.rs (camelCase). */
export interface AgentAccess {
    enabled: boolean
    databasePath: string
    /** The server program an agent runs, and its arguments. */
    command: string
    args: string[]
    /** The server program is there; a development build may lack it. */
    serverFound: boolean
    /**
     * macOS runs an app opened from Downloads from a read-only copy whose
     * path changes at every launch, so a command naming it would break.
     */
    translocated: boolean
    /** One line for a terminal: `claude mcp add …`. */
    claudeCodeCommand: string
    /** The JSON to paste into Claude Desktop's configuration. */
    claudeDesktopConfig: string
    /** "Add to Claude Desktop" can build an extension here (Windows and macOS). */
    extensionSupported: boolean
    /** The extension added before runs a server path this app no longer has. */
    extensionMoved: boolean
}

/** Mirrors `AddedExtension` in claude_desktop_extension.rs. */
export interface AddedExtension {
    /** The bundle, to install by hand when nothing opened it. */
    bundle: string
    /** Claude Desktop was asked to open it. */
    opened: boolean
    openError: string | null
}

export const agentKeys = {
    all: ['agents'] as const,
    access: () => [...agentKeys.all, 'access'] as const,
}

export const getAgentAccess = () => command<AgentAccess>('get_agent_access')

export const agentAccessQuery = queryOptions({queryKey: agentKeys.access(), queryFn: getAgentAccess})

/** Answers the new state, which the query takes as it is: only this call changes it. */
export const setAgentAccessMutation = mutationOptions({
    mutationFn: (enabled: boolean) => command<AgentAccess>('set_agent_access', {enabled}),
    onSuccess: (access, _enabled, _result, {client}) => client.setQueryData(agentKeys.access(), access),
})

/**
 * Builds Protocol's extension and asks Claude Desktop to open it (Windows
 * and macOS). Refuses while access is off or the server has no lasting path.
 */
export const addToClaudeDesktopMutation = mutationOptions({
    mutationFn: () => command<AddedExtension>('add_to_claude_desktop'),
    // `extensionMoved` is answered again.
    onSettled: (_added, _error, _variables, _result, {client}) => client.invalidateQueries({queryKey: agentKeys.access()}),
})
