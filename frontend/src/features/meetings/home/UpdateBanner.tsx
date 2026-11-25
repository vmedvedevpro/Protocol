import {useState} from 'react'
import {DownloadSimpleIcon} from '@phosphor-icons/react'
import styled from 'styled-components'
import {errorMessage} from '@/api/core'
import {openLink} from '@/api/links'
import {installRefusal, installUpdate, type Offer, type UpdaterSnapshot} from '@/api/updater'
import {ReleaseNotes} from '@/components/releaseNotes/ReleaseNotes'
import {Button} from '@/components/ui/Button'
import {Sheet} from '@/components/ui/Sheet'
import {toast} from '@/components/ui/toastStore'
import {busySentence, errorSentence, MAC_PERMISSIONS_NOTE, releaseUrl, RESTART_NOTE} from '@/lib/updateText'
import {Banner} from './Banner'

const Fine = styled.p`
    margin: ${({theme}) => theme.space[3]} 0 0;
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

/**
 * Home's banner while a downloaded update waits for a restart (the old
 * update pill and panel). Restart and update installs it at once, unless
 * work is running: native refuses then, and the banner says what it waits
 * for. Release notes opens them in a sheet. A failed install shows in the
 * snapshot, and the banner says what went wrong.
 */
export function UpdateBanner({snapshot, offer}: { snapshot: UpdaterSnapshot, offer: Offer }) {
    const [installing, setInstalling] = useState(false)
    const [waitingFor, setWaitingFor] = useState<string | null>(null)
    const [notesOpen, setNotesOpen] = useState(false)
    const {version} = offer.release

    const install = async () => {
        setInstalling(true)
        setWaitingFor(null)
        try {
            await installUpdate()
        } catch (error) {
            const refusal = installRefusal(error)
            if (refusal?.kind === 'busy' && refusal.reasons.length > 0) setWaitingFor(busySentence(refusal.reasons[0]))
            else if (refusal?.kind === 'notReady') toast.info('The update isn’t ready to install yet')
            else toast.error('Couldn’t install the update', {description: errorMessage(error)})
        } finally {
            setInstalling(false)
        }
    }

    const failed = snapshot.error?.action === 'install'
        ? errorSentence(snapshot.error, snapshot.platform, version, snapshot.currentVersion)
        : null
    const busy = installing || snapshot.activity.state === 'installing'
    const restart = (
        <Button size="sm" variant="filled" pending={busy} onClick={() => void install()}>Restart and update</Button>
    )

    return (
        <>
            <Banner
                icon={<DownloadSimpleIcon aria-hidden/>}
                title="Update ready"
                description={waitingFor ?? failed ?? `Protocol ${version} is downloaded. Restart when it suits you, or it installs when you quit.`}
                actions={(
                    <>
                        {restart}
                        <Button size="sm" onClick={() => setNotesOpen(true)}>Release notes</Button>
                    </>
                )}
            />
            <Sheet
                open={notesOpen}
                onOpenChange={setNotesOpen}
                title={`What’s new in ${version}`}
                footer={(
                    <>
                        <Button onClick={() => openLink(releaseUrl(version))}>Open on GitHub</Button>
                        {restart}
                    </>
                )}
            >
                <ReleaseNotes notes={offer.release.notes?.trim() || 'No release notes were published with this version.'}/>
                <Fine>{RESTART_NOTE}{snapshot.platform === 'macos' ? ` ${MAC_PERMISSIONS_NOTE}` : ''}</Fine>
            </Sheet>
        </>
    )
}
