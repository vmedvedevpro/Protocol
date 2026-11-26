import {useMutation, useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import {dataFolderQuery, openDataFolder} from '@/api/app'
import {errorMessage} from '@/api/core'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {SettingsGroup, SettingsNavRow, SettingsRow} from '@/components/ui/SettingsRow'
import {Switch} from '@/components/ui/Switch'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'
import {agentAccessQuery, setAgentAccessMutation} from '../api/agents'
import {agentBlocker} from './agentTexts'
import {Warning} from './styles'

/**
 * Settings › Advanced › AI agents: whether agents may read the meetings,
 * and where to connect them. The switch takes effect at an agent's next
 * question; nothing needs restarting.
 */
export function AgentsGroup() {
    const navigate = useNavigate()
    const access = useQuery(agentAccessQuery)
    const toggle = useMutation({
        ...setAgentAccessMutation,
        onError: (error) => toast.error('Couldn’t change access for AI agents', {description: errorMessage(error)}),
    })
    const on = toggle.isPending ? toggle.variables : access.data?.enabled ?? false
    const blocker = access.data && agentBlocker(access.data)
    const connect = () => void navigate(paths.settingsPage('agents'))

    return (
        <SettingsGroup title="AI agents">
            <SettingsRow
                label="Let AI agents read your meetings"
                description={access.isError
                    ? <Warning as="span">{errorMessage(access.error)}</Warning>
                    : blocker ? <Warning as="span">{blocker}</Warning> : undefined}
                control={(
                    <Switch
                        checked={on}
                        disabled={!access.data || (blocker !== undefined && !on)}
                        onCheckedChange={(enabled) => toggle.mutate(enabled)}
                    />
                )}
            />
            <Collapse open={on && access.data !== undefined}>
                <SettingsNavRow label="Connect Claude Code" onClick={connect}/>
            </Collapse>
            <Collapse open={on && access.data !== undefined}>
                <SettingsNavRow
                    label="Connect Claude Desktop"
                    description={access.data?.extensionMoved ? 'Protocol moved since you added it. Add it again.' : undefined}
                    onClick={connect}
                />
            </Collapse>
        </SettingsGroup>
    )
}

/** Where the meetings database and the models are; recordings have their own folder (Settings › Recording). */
export function DiskGroup() {
    const folder = useQuery(dataFolderQuery)
    const open = useMutation({
        mutationFn: openDataFolder,
        onError: (error) => toast.error('Couldn’t open the folder', {description: errorMessage(error)}),
    })
    return (
        <SettingsGroup>
            <SettingsRow
                label="Disk"
                description={folder.data ? `Meetings database and models\n${folder.data}` : 'Meetings database and models'}
                control={<Button size="sm" pending={open.isPending} onClick={() => open.mutate()}>Show folder</Button>}
            />
        </SettingsGroup>
    )
}
