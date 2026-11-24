/**
 * General › Updates: Protocol's own update, the daily check, and the model
 * list. Native code owns every check, download and install
 * (src/api/updater.ts); this shows the snapshot `updater-status` keeps
 * current and sends clicks. Nothing downloads or installs without one.
 */
import {type ReactNode, useEffect, useRef, useState} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {CaretDownIcon} from '@phosphor-icons/react'
import {AnimatePresence} from 'motion/react'
import * as m from 'motion/react-m'
import {useSearchParams} from 'react-router-dom'
import styled from 'styled-components'
import {useEventQuerySync} from '@/api/events'
import {openLink} from '@/api/links'
import {
    catalogStatusQuery,
    checkForModelUpdates,
    MODEL_CATALOG_CHANGED_EVENT,
} from '@/api/modelCatalog'
import {
    type BusyReason,
    checkForUpdates,
    downloadPercent,
    downloadUpdate,
    installUpdate,
    installRefusal,
    setUpdateAutoCheck,
    type UpdaterSnapshot,
    updaterStatusQuery,
} from '@/api/updater'
import {Button} from '@/components/ui/Button'
import {Collapse} from '@/components/ui/Collapse'
import {ProgressBar} from '@/components/ui/ProgressBar'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {StatusLine} from '@/components/ui/StatusLine'
import {focusRing} from '@/components/ui/styles'
import {Switch} from '@/components/ui/Switch'
import {
    busySentence,
    errorSentence,
    MAC_PERMISSIONS_NOTE,
    MANUAL_NOTE,
    RELEASES_URL,
    releaseUrl,
    relativeTime,
    RESTART_NOTE,
} from '@/lib/updateText'
import {tween} from '@/styles/motion'
import {ReleaseNotes} from './ReleaseNotes'
import {Warning} from './styles'
import {appUpdateStatus, catalogStatus} from './updateStatus'

/** How long a refused Restart and update keeps saying why. */
const REFUSAL_MS = 10_000

/** The time now, again every minute, for "checked 5 minutes ago". */
function useNow() {
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 60_000)
        return () => clearInterval(timer)
    }, [])
    return now
}

const Actions = styled(m.div)`
    display: flex;
    flex: none;
    gap: ${({theme}) => theme.space[1.5]};
`

const fade = {
    initial: {opacity: 0},
    animate: {opacity: 1},
    exit: {opacity: 0},
    transition: tween('fast'),
}

const Notes = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

const Disclosure = styled.button`
    display: inline-flex;
    align-items: center;
    gap: ${({theme}) => theme.space[1]};
    align-self: flex-start;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: ${({theme}) => theme.radii.xs};
    background: none;
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    color: ${({theme}) => theme.colors.soft};
    cursor: pointer;
    ${focusRing};

    &:hover {
        color: ${({theme}) => theme.colors.text};
    }

    > svg {
        transition: transform ${({theme}) => theme.motion.duration.base} ${({theme}) => theme.motion.easing.standard};
    }

    &[aria-expanded='true'] > svg {
        transform: rotate(180deg);
    }
`

const WhatsNewBody = styled.div`
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2]};
    padding-top: ${({theme}) => theme.space[2]};
`

/** The offered release's notes, behind "What's new", and its page on GitHub. */
function WhatsNew({version, notes}: {version: string; notes: string | null}) {
    const [shown, setShown] = useState(false)
    return (
        <div>
            <Disclosure type="button" aria-expanded={shown} onClick={() => setShown(!shown)}>
                What’s new in {version}
                <CaretDownIcon size={11} aria-hidden/>
            </Disclosure>
            <Collapse open={shown}>
                <WhatsNewBody>
                    {notes ? <ReleaseNotes notes={notes}/> : <Notes>This release has no notes.</Notes>}
                    <Button variant="ghost" size="sm" onClick={() => openLink(releaseUrl(version))}>Open on GitHub</Button>
                </WhatsNewBody>
            </Collapse>
        </div>
    )
}

/** Why a click failed when native rejected instead of answering with a snapshot. */
const failureOf = (error: Error | null) => (error && !installRefusal(error) ? error.message : null)

function AppUpdateRow({snapshot}: {snapshot: UpdaterSnapshot}) {
    const now = useNow()
    const check = useMutation({mutationFn: checkForUpdates})
    const download = useMutation({mutationFn: downloadUpdate})
    // A busy refusal names the work: the snapshot's busy reasons can lag
    // behind what native just refused for.
    const [refusedFor, setRefusedFor] = useState<BusyReason | null>(null)
    const install = useMutation({
        mutationFn: installUpdate,
        onError: (error) => {
            const refusal = installRefusal(error)
            if (refusal?.kind === 'busy') setRefusedFor(refusal.reasons[0] ?? null)
        },
    })
    useEffect(() => {
        if (!refusedFor) return
        const timer = setTimeout(() => setRefusedFor(null), REFUSAL_MS)
        return () => clearTimeout(timer)
    }, [refusedFor])

    const {support, activity, offer, error, busyReasons, platform, currentVersion} = snapshot
    const idle = activity.state === 'idle'
    const foreground = error && !error.background ? error : null
    // Without an offer the status line says a failed check; with one (the
    // tray's Check for Updates lands here) the alert must.
    const alert = foreground && (foreground.action !== 'check' || offer)
        ? errorSentence(foreground, platform, offer?.release.version, currentVersion)
        : failureOf(check.error) ?? failureOf(download.error) ?? failureOf(install.error)
    const busy = refusedFor ?? busyReasons[0]
    const blocked = offer?.downloaded && busy ? busySentence(busy) : null
    const lastFailure = error?.background && !offer ? error : null

    let actions: {key: string; buttons: ReactNode}
    if (support.kind === 'off') {
        actions = {key: 'off', buttons: <Button size="sm" onClick={() => openLink(RELEASES_URL)}>Open releases</Button>}
    } else if (offer?.manualOnly) {
        actions = {
            key: 'manual',
            buttons: <Button variant="filled" size="sm" onClick={() => openLink(releaseUrl(offer.release.version))}>Download from GitHub</Button>,
        }
    } else if (offer?.downloaded) {
        actions = {
            key: 'install',
            buttons: (
                <Button
                    variant="filled"
                    size="sm"
                    disabled={!idle || busyReasons.length > 0}
                    pending={install.isPending}
                    onClick={() => install.mutate()}
                >
                    Restart and update
                </Button>
            ),
        }
    } else if (offer) {
        actions = {
            key: 'download',
            buttons: (
                <Button
                    variant="filled"
                    size="sm"
                    disabled={!idle || offer.waitingForRecording}
                    pending={download.isPending}
                    onClick={() => download.mutate()}
                >
                    {foreground?.action === 'download' ? 'Try again' : 'Download'}
                </Button>
            ),
        }
    } else {
        actions = {
            key: 'check',
            buttons: (
                <Button size="sm" disabled={!idle} onClick={() => check.mutate()}>
                    {foreground?.action === 'check' ? 'Try again' : 'Check now'}
                </Button>
            ),
        }
    }

    const notes = [
        offer?.manualOnly && MANUAL_NOTE,
        offer?.downloaded && RESTART_NOTE,
        offer && !offer.manualOnly && platform === 'macos' && MAC_PERMISSIONS_NOTE,
        lastFailure && `The last check failed ${relativeTime(lastFailure.at, now)}: ${errorSentence(lastFailure, platform)}`,
    ].filter((note): note is string => Boolean(note))

    return (
        <SettingsRow
            label={`Protocol ${currentVersion}`}
            description={<StatusLine status={appUpdateStatus(snapshot, now)}/>}
            control={(
                <AnimatePresence mode="wait" initial={false}>
                    <Actions key={actions.key} {...fade}>{actions.buttons}</Actions>
                </AnimatePresence>
            )}
        >
            <Collapse open={activity.state === 'downloading'}>
                <ProgressBar label="Download progress" value={downloadPercent(activity) ?? 0}/>
            </Collapse>
            <Collapse open={notes.length > 0 || blocked !== null}>
                <Notes>
                    {blocked && <Warning>{blocked}</Warning>}
                    {notes.map((note) => <p key={note}>{note}</p>)}
                </Notes>
            </Collapse>
            <Collapse open={alert !== null}>
                <Warning role="alert">{alert}</Warning>
            </Collapse>
            {offer && <WhatsNew key={offer.release.version} version={offer.release.version} notes={offer.release.notes}/>}
        </SettingsRow>
    )
}

/** The daily check, which also asks about model updates, so it shows even where app updates are off. */
function AutoCheckRow({snapshot}: {snapshot: UpdaterSnapshot}) {
    const toggle = useMutation({mutationFn: setUpdateAutoCheck})
    // Only `updater-status` writes the snapshot; meanwhile the switch shows the click.
    const checked = toggle.isPending && toggle.variables !== undefined ? toggle.variables : snapshot.autoCheck
    return (
        <SettingsRow
            label="Check for updates automatically"
            description="App and models, once a day. Downloads only when you click, never installs during a recording"
            control={<Switch checked={checked} onCheckedChange={(on) => toggle.mutate(on)}/>}
        />
    )
}

function ModelUpdatesRow() {
    useEventQuerySync(MODEL_CATALOG_CHANGED_EVENT, catalogStatusQuery.queryKey)
    const now = useNow()
    const status = useQuery(catalogStatusQuery)
    const check = useMutation({mutationFn: checkForModelUpdates})
    const checking = status.data?.checking || check.isPending
    // An entry that breaks several rules is listed once per problem.
    const hidden = new Set(status.data?.hidden.map(({index}) => index)).size
    const failure = status.data?.error ?? check.error?.message ?? null

    return (
        <SettingsRow
            label="Model updates"
            description={<StatusLine status={status.data ? catalogStatus(status.data, now) : {key: 'loading', text: 'Speech and summary model files'}}/>}
            control={<Button size="sm" disabled={!status.data || checking} onClick={() => check.mutate()}>Check</Button>}
        >
            <Collapse open={failure !== null}>
                <Warning role="alert">{failure}</Warning>
            </Collapse>
            {hidden > 0 && <Notes>{hidden === 1 ? '1 entry' : `${hidden} entries`} of the model list can’t be used by this version.</Notes>}
        </SettingsRow>
    )
}

// The tray's About lands here, a little below the page's top edge.
const Anchor = styled.div`
    scroll-margin-top: ${({theme}) => theme.space[3]};
`

/**
 * Settings › General › Updates. The old About held the updates, and the
 * tray's Check for Updates… still opens `?section=about`: the group scrolls
 * itself into view, then the id becomes `general`, so going back does not
 * scroll again.
 */
export function UpdatesGroup() {
    const updater = useQuery(updaterStatusQuery)
    const anchor = useRef<HTMLDivElement>(null)
    const [search, setSearch] = useSearchParams()
    useEffect(() => {
        if (search.get('section') !== 'about') return
        anchor.current?.scrollIntoView({block: 'start'})
        setSearch({section: 'general'}, {replace: true})
    }, [search, setSearch])
    return (
        <Anchor ref={anchor}>
            <SettingsGroup title="Updates">
                {updater.data
                    ? <AppUpdateRow snapshot={updater.data}/>
                    : <SettingsRow label="Protocol" description={updater.isError ? 'Couldn’t read the update status' : undefined}/>}
                {updater.data && <AutoCheckRow snapshot={updater.data}/>}
                <ModelUpdatesRow/>
            </SettingsGroup>
        </Anchor>
    )
}
