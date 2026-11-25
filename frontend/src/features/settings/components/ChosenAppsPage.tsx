import {useState} from 'react'
import {MagnifyingGlassIcon} from '@phosphor-icons/react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import type {PerAppTarget} from '@/api/devices'
import {Button} from '@/components/ui/Button'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Spinner} from '@/components/ui/Spinner'
import {TextField} from '@/components/ui/TextField'
import {toast} from '@/components/ui/toastStore'
import {pickAppExecutable, type RecordableApp, recordableAppsQuery, sameApp, targetOf} from '../api/apps'
import {useRecordingPreferences} from '../hooks/useRecordingPreferences'
import {SubpageGroups, SubpageScroll} from './subpage'

/** One row a running app, the first of its program. */
function uniqueApps(apps: RecordableApp[]) {
    return apps.filter((app, index) => apps.findIndex((other) => sameApp(other, app)) === index)
}

function AppRows({apps, onAdd}: {apps: RecordableApp[], onAdd: (app: RecordableApp) => void}) {
    return apps.map((app) => (
        <SettingsRow
            key={app.executable}
            label={app.name}
            description={app.name === app.executable ? undefined : app.executable}
            control={<Button size="sm" onClick={() => onAdd(app)}>Add</Button>}
        />
    ))
}

/**
 * Settings › Recording › Chosen apps: the apps whose sound alone a
 * recording takes (Windows and macOS), from those open now or picked from
 * the disk. Each change is saved at once, as the recording preferences are.
 */
export function ChosenAppsPage() {
    const {preferences, save} = useRecordingPreferences()
    const targets = preferences?.per_app_targets ?? []
    const running = useQuery(recordableAppsQuery)
    const [search, setSearch] = useState('')

    const add = (app: RecordableApp | PerAppTarget) => {
        if (!targets.some((target) => sameApp(target, app))) save({per_app_targets: [...targets, targetOf(app)]})
    }
    const remove = (target: PerAppTarget) => save({per_app_targets: targets.filter((other) => !sameApp(other, target))})
    const browse = useMutation({
        mutationFn: pickAppExecutable,
        onSuccess: (app) => app && add(app),
        onError: (error) => toast.error('Couldn’t add the app', {description: errorMessage(error)}),
    })

    const needle = search.trim().toLocaleLowerCase()
    const offered = uniqueApps(running.data ?? []).filter((app) =>
        !targets.some((target) => sameApp(target, app))
        && (!needle || `${app.name} ${app.executable}`.toLocaleLowerCase().includes(needle)))
    const playing = offered.filter((app) => app.has_audio)
    const open = offered.filter((app) => !app.has_audio)

    return (
        <SubpageScroll>
            <SubpageGroups>
                <SettingsGroup title="Recording these apps">
                    {targets.length === 0 && <SettingsRow label="No apps yet"/>}
                    {targets.map((target) => (
                        <SettingsRow
                            key={target.id}
                            label={target.name}
                            control={<Button size="sm" variant="ghost" onClick={() => remove(target)}>Remove</Button>}
                        />
                    ))}
                </SettingsGroup>
                <SettingsGroup>
                    <SettingsRow label="Add an app">
                        <TextField
                            type="search"
                            icon={<MagnifyingGlassIcon size={14} aria-hidden/>}
                            placeholder="Search open apps"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                        />
                    </SettingsRow>
                </SettingsGroup>
                {running.isPending && (
                    <SettingsGroup>
                        <SettingsRow label="Open apps" description="Looking for open apps…" control={<Spinner/>}/>
                    </SettingsGroup>
                )}
                {running.isError && (
                    <SettingsGroup>
                        <SettingsRow
                            label="Couldn’t list the open apps"
                            description={errorMessage(running.error)}
                            control={<Button size="sm" onClick={() => void running.refetch()}>Try again</Button>}
                        />
                    </SettingsGroup>
                )}
                {playing.length > 0 && (
                    <SettingsGroup title="Playing sound now"><AppRows apps={playing} onAdd={add}/></SettingsGroup>
                )}
                {open.length > 0 && <SettingsGroup title="Open apps"><AppRows apps={open} onAdd={add}/></SettingsGroup>}
                {running.isSuccess && offered.length === 0 && needle && (
                    <SettingsGroup>
                        <SettingsRow label={`No open app matches “${search.trim()}”`}/>
                    </SettingsGroup>
                )}
                <SettingsGroup>
                    <SettingsRow
                        label="An app that is not open"
                        control={<Button size="sm" pending={browse.isPending} onClick={() => browse.mutate()}>Browse…</Button>}
                    />
                </SettingsGroup>
            </SubpageGroups>
        </SubpageScroll>
    )
}
