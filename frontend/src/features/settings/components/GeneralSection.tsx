import {openLink} from '@/api/links'
import {SettingsGroup, SettingsNavRow} from '@/components/ui/SettingsRow'
import {NameRow, ThemeRow} from './PreferenceRows'
import {UpdatesGroup} from './UpdatesGroup'

const REPOSITORY_URL = 'https://github.com/vmedvedevpro/Protocol'
const PRIVACY_URL = `${REPOSITORY_URL}/blob/main/PRIVACY_POLICY.md`
const CREDITS_URL = `${REPOSITORY_URL}#credits-and-license`

/** Settings › General: the look, the name, updates and About (the old About dialog and section). */
export function GeneralSection() {
    return (
        <>
            <SettingsGroup title="Appearance">
                <ThemeRow description="Every window, including the recording bar"/>
            </SettingsGroup>
            <SettingsGroup title="You">
                <NameRow/>
            </SettingsGroup>
            <UpdatesGroup/>
            <SettingsGroup
                title="About"
                note="Based on Meetily – Actually Free and the open-source Meetily project. MIT licensed."
            >
                <SettingsNavRow label="Source code" description="On GitHub" external onClick={() => openLink(REPOSITORY_URL)}/>
                <SettingsNavRow label="Privacy policy" external onClick={() => openLink(PRIVACY_URL)}/>
                <SettingsNavRow
                    label="Credits"
                    description="Models and open-source libraries"
                    external
                    onClick={() => openLink(CREDITS_URL)}
                />
            </SettingsGroup>
        </>
    )
}
