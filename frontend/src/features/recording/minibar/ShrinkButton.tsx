import {ArrowsInSimpleIcon} from '@phosphor-icons/react'
import {errorMessage} from '@/api/core'
import {IconButton} from '@/components/ui/Button'
import {toast} from '@/components/ui/toastStore'
import {clockSeconds, session} from '../store/session'
import {enterCompactMode} from './api'

async function shrink() {
    try {
        // The bar reads its timer from native; the seconds only mark this as the user's shrink.
        await enterCompactMode(Math.floor(clockSeconds(session.get())))
    } catch (error) {
        toast.error('Could not shrink to the floating bar', {description: errorMessage(error)})
    }
}

/**
 * The recording bar's way into the minibar without minimizing: native hides
 * the main window and shows the bar, as minimizing during a recording does.
 */
export function ShrinkButton() {
    return (
        <IconButton label="Shrink to floating bar" size="sm" onClick={() => void shrink()}>
            <ArrowsInSimpleIcon size={13}/>
        </IconButton>
    )
}
