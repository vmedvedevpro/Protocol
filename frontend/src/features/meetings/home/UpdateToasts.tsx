import {useEffect, useRef} from 'react'
import {useQuery} from '@tanstack/react-query'
import {useNavigate} from 'react-router-dom'
import {openLink} from '@/api/links'
import {updaterStatusQuery} from '@/api/updater'
import {toast} from '@/components/ui/toastStore'
import {paths} from '@/lib/paths'
import {releaseUrl} from '@/lib/updateText'
import {claimToast} from '../lib/updates'

// Long enough to read a version and act on it.
const UPDATE_TOAST_MS = 10_000

/**
 * The window's update toasts, mounted once in the shell: one per version
 * when a release becomes available, one when its download is ready (only a
 * download finished in this session; one restored at launch is Home's
 * banner alone), and one after an update installed. They wait while a
 * recording runs. Details opens Settings › Updates.
 */
export function UpdateToasts() {
    const {data: status} = useQuery(updaterStatusQuery)
    const navigate = useNavigate()
    const downloadedAtMount = useRef<string | null | undefined>(undefined)

    useEffect(() => {
        if (!status) return
        if (downloadedAtMount.current === undefined) {
            downloadedAtMount.current = status.offer?.downloaded ? status.offer.release.version : null
        }
        const details = {label: 'Details', onClick: () => void navigate(paths.settings('about'))}
        if (status.updatedFrom && claimToast('updated', status.currentVersion)) {
            const version = status.currentVersion
            toast.success(`Updated to Protocol ${version}`, {
                id: `updater-updated-${version}`,
                duration: UPDATE_TOAST_MS,
                action: {label: 'What’s new', onClick: () => openLink(releaseUrl(version))},
            })
        }
        const offer = status.offer
        if (!offer || status.busyReasons.includes('recording')) return
        const {version} = offer.release
        if (offer.downloaded) {
            if (downloadedAtMount.current !== version && claimToast('ready', version)) {
                toast(`Protocol ${version} is ready to install`, {
                    id: `updater-ready-${version}`,
                    description: 'Restart when it suits you, or it installs when you quit.',
                    duration: UPDATE_TOAST_MS,
                    action: details,
                })
            }
        } else if (claimToast('available', version)) {
            toast(`Protocol ${version} is available`, {
                id: `updater-available-${version}`,
                description: offer.manualOnly ? 'Download the new package from GitHub.' : 'Download it when it suits you.',
                duration: UPDATE_TOAST_MS,
                action: details,
            })
        }
    }, [status, navigate])

    return null
}
