import {openExternalUrl} from '@/api/links'
import {SettingsGroup, SettingsNavRow} from '@/components/ui/SettingsRow'
import {NameRow, ThemeRow} from './PreferenceRows'
import {UpdatesGroup} from './UpdatesGroup'

const REPOSITORY_URL = 'https://github.com/vmedvedevpro/Protocol'
const PRIVACY_URL = `${REPOSITORY_URL}/blob/main/PRIVACY_POLICY.md`
const CREDITS_URL = `${REPOSITORY_URL}#credits-and-license`

const open = (url: string) => void openExternalUrl(url).catch(() => undefined)

interface GeneralSectionProps {
    /** Scrolls Updates into view (the tray's About); `onUpdatesRevealed` says it has. */
    revealUpdates?: boolean
    onUpdatesRevealed?: () => void
}

/** Settings › General: the look, the name, updates and About (the old About dialog and section). */
export function GeneralSection({revealUpdates = false, onUpdatesRevealed}: GeneralSectionProps) {
    return (
        <>
            <SettingsGroup title="Appearance">
                <ThemeRow description="Every window, including the recording bar"/>
            </SettingsGroup>
            <SettingsGroup title="You">
                <NameRow/>
            </SettingsGroup>
            <UpdatesGroup reveal={revealUpdates} onRevealed={onUpdatesRevealed}/>
            <SettingsGroup
                title="About"
                note="Based on Meetily – Actually Free and the open-source Meetily project. MIT licensed."
            >
                <SettingsNavRow label="Source code" description="On GitHub" external onClick={() => open(REPOSITORY_URL)}/>
                <SettingsNavRow label="Privacy policy" external onClick={() => open(PRIVACY_URL)}/>
                <SettingsNavRow
                    label="Credits"
                    description="Models and open-source libraries"
                    external
                    onClick={() => open(CREDITS_URL)}
                />
            </SettingsGroup>
        </>
    )
}
