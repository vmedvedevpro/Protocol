import {useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {toast} from '@/components/ui/toastStore'
import {addToClaudeDesktopMutation, agentAccessQuery, type AgentAccess, setAgentAccessMutation} from '../api/agents'
import {agentBlocker, BY_HAND} from './agentTexts'
import {CodeBlock} from './CodeBlock'
import {Warning} from './styles'
import {SubpageGroups, SubpageScroll} from './subpage'

/** Claude Desktop's configuration to paste, and how. */
function ByHandRow({access}: {access: AgentAccess}) {
    return (
        <SettingsRow label="Add to the Claude Desktop configuration" description={BY_HAND}>
            <CodeBlock label="Claude Desktop configuration" text={access.claudeDesktopConfig}/>
        </SettingsRow>
    )
}

/** Windows and macOS: Protocol's extension, which Claude Desktop installs; by hand as a fallback. */
function ClaudeDesktopRows({access}: {access: AgentAccess}) {
    const [byHand, setByHand] = useState(false)
    const add = useMutation({
        ...addToClaudeDesktopMutation,
        onSuccess: ({opened, openError}) => {
            if (opened) {
                toast.success('Finish in Claude Desktop', {description: 'If nothing opened, set it up by hand below.'})
                return
            }
            setByHand(true)
            toast.error('Claude Desktop didn’t open the extension', {description: openError ?? 'Set it up by hand below.'})
        },
        onError: (error) => toast.error('Couldn’t add Protocol to Claude Desktop', {description: errorMessage(error)}),
    })
    return (
        <>
            <SettingsRow
                label="Add to Claude Desktop"
                description={access.extensionMoved
                    ? <Warning as="span">Protocol moved since you added it. Add it again.</Warning>
                    : add.data?.opened ? 'Finish in Claude Desktop. If nothing opened, set it up by hand below.' : 'Installs the Protocol extension'}
                control={<Button size="sm" variant="filled" pending={add.isPending} onClick={() => add.mutate()}>Add</Button>}
            />
            <SettingsRow
                label="Set up by hand"
                description="Copy the configuration instead"
                control={(
                    <Button size="sm" variant="ghost" aria-expanded={byHand} onClick={() => setByHand(!byHand)}>
                        {byHand ? 'Hide' : 'Show'}
                    </Button>
                )}
            />
            <Collapse open={byHand}><ByHandRow access={access}/></Collapse>
        </>
    )
}

/**
 * Settings › Advanced › Connect an agent: the command for Claude Code and
 * Protocol in Claude Desktop. Only while access is on: an agent connected
 * before that finds nothing to read.
 */
export function AgentsPage() {
    const access = useQuery(agentAccessQuery)
    const turnOn = useMutation({
        ...setAgentAccessMutation,
        onError: (error) => toast.error('Couldn’t turn on access for AI agents', {description: errorMessage(error)}),
    })
    const data = access.data
    const blocker = data && agentBlocker(data)

    return (
        <SubpageScroll>
            <SubpageGroups>
                {access.isPending && <Spinner delayed/>}
                {access.isError && <Warning>Couldn’t read access for AI agents: {errorMessage(access.error)}</Warning>}
                {blocker && <Warning>{blocker}</Warning>}
                {data && !data.enabled && !blocker && (
                    <SettingsGroup>
                        <SettingsRow
                            label="Access for AI agents is off"
                            description="Turn it on so a connected agent can read your meetings"
                            control={<Button size="sm" pending={turnOn.isPending} onClick={() => turnOn.mutate(true)}>Turn on</Button>}
                        />
                    </SettingsGroup>
                )}
                {data?.enabled && !blocker && (
                    <>
                        <SettingsGroup title="Claude Code">
                            <SettingsRow label="Run once in a terminal" description="Claude Code then offers Protocol’s tools in every project.">
                                <CodeBlock label="Claude Code command" text={data.claudeCodeCommand}/>
                            </SettingsRow>
                        </SettingsGroup>
                        <SettingsGroup title="Claude Desktop">
                            {data.extensionSupported ? <ClaudeDesktopRows access={data}/> : <ByHandRow access={data}/>}
                        </SettingsGroup>
                    </>
                )}
            </SubpageGroups>
        </SubpageScroll>
    )
}
