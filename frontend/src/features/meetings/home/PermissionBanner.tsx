import {useState} from 'react'
import {WarningCircleIcon} from '@phosphor-icons/react'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {deviceKeys} from '@/api/devices'
import {
    openPrivacySettings,
    permissionKeys,
    type PrivacyPane,
    requestMicrophonePermission,
    systemAudioPermissionQuery,
    systemAudioProbeQuery,
} from '@/api/permissions'
import {Button} from '@/components/ui/Button'
import {toast} from '@/components/ui/toastStore'
import {platform as currentPlatform, type Platform} from '@/lib/platform'
import type {AudioAccess} from './audioAccess'
import {Banner} from './Banner'

// What to do on macOS depends on what its Audio Capture record says.
const MAC_AUDIO_HINT = {
    denied: 'Audio Capture is turned off for Protocol. Turn it on in System Settings, then check again.',
    not_determined: 'macOS hasn’t confirmed access yet. Check again and allow Protocol to record computer audio. If you already did, play some audio and check again.',
    granted: '',
    unknown: 'Allow Audio Capture for Protocol in System Settings, play some audio, then check again.',
}

function describe(access: AudioAccess, on: Platform, permission: keyof typeof MAC_AUDIO_HINT): {title: string, description: string} {
    const title = !access.microphone && !access.computerAudio
        ? 'Protocol can’t hear your microphone or computer audio'
        : !access.microphone ? 'Protocol can’t hear your microphone' : 'Protocol can’t hear your computer audio'
    const parts: string[] = []
    if (!access.microphone) {
        parts.push('No microphone was found. Check that one is connected and that Protocol may use it.')
    }
    if (!access.computerAudio) {
        if (on === 'macos' && MAC_AUDIO_HINT[permission]) parts.push(MAC_AUDIO_HINT[permission])
        else parts.push('The other side of a call won’t be recorded.')
    }
    return {title, description: parts.join(' ')}
}

/**
 * Home's banner while Protocol cannot hear the microphone or the computer
 * audio, with the way to fix it: on macOS the privacy panes, everywhere
 * Check again, which asks the system again (a prompt the first time) and
 * reads the devices and permissions anew. Linux asks for nothing, so it
 * shows none.
 */
export function PermissionBanner({access, on = currentPlatform}: { access: AudioAccess, on?: Platform }) {
    const client = useQueryClient()
    const permission = useQuery({...systemAudioPermissionQuery, enabled: on === 'macos'})
    const [checking, setChecking] = useState(false)
    const {title, description} = describe(access, on, permission.data ?? 'unknown')

    const open = (pane: PrivacyPane) => {
        openPrivacySettings(pane).catch((error: unknown) =>
            toast.error('Couldn’t open System Settings', {description: errorMessage(error)}))
    }

    const checkAgain = async () => {
        setChecking(true)
        try {
            await requestMicrophonePermission().catch(() => false)
            // The probe may prompt and listens for up to 5 s; it proves a
            // grant macOS has not recorded yet.
            if (on === 'macos') await client.fetchQuery({...systemAudioProbeQuery, staleTime: 0}).catch(() => false)
            await Promise.all([
                client.invalidateQueries({queryKey: deviceKeys.list()}),
                client.invalidateQueries({queryKey: permissionKeys.systemAudio()}),
            ])
        } finally {
            setChecking(false)
        }
    }

    return (
        <Banner
            icon={<WarningCircleIcon aria-hidden/>}
            title={title}
            description={description}
            actions={(
                <>
                    {on === 'macos' && !access.microphone && (
                        <Button size="sm" variant="filled" onClick={() => open('Privacy_Microphone')}>Microphone settings</Button>
                    )}
                    {on === 'macos' && !access.computerAudio && (
                        <Button size="sm" variant={access.microphone ? 'filled' : 'secondary'} onClick={() => open('Privacy_AudioCapture')}>
                            Audio Capture settings
                        </Button>
                    )}
                    <Button size="sm" variant={on === 'macos' ? 'secondary' : 'filled'} pending={checking} onClick={() => void checkAgain()}>
                        Check again
                    </Button>
                </>
            )}
        />
    )
}
