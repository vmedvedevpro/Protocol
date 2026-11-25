import type {AgentAccess} from '../api/agents'

/** What agents can read, and where it goes: the old settings' words. */
export const AGENT_PRIVACY = 'An AI agent on this computer, such as Claude Desktop or Claude Code, can read your meetings: transcripts, summaries, notes, action items, people and groups. It can’t change anything or play audio. Whatever the agent reads is sent to the agent’s model provider (for Claude, Anthropic) under your account.'

/** Why access can't work on this install, if it can't. */
export function agentBlocker(access: AgentAccess): string | undefined {
    if (access.translocated) return 'Move Protocol to the Applications folder first. macOS runs it from a temporary copy whose location changes on every launch, so an agent could not find it.'
    if (!access.serverFound) return `This build doesn’t include the server (${access.command} is missing).`
    return undefined
}

export const BY_HAND = 'Paste into Claude Desktop > Settings > Developer > Edit Config, then restart Claude Desktop. If the file already lists servers under mcpServers, add the protocol entry next to them.'
