import type {ReactElement} from 'react'
import {useMutation, useQuery} from '@tanstack/react-query'
import {GearIcon} from '@phosphor-icons/react'
import {
    audioDevicesQuery,
    type AudioDevice,
    deviceInUse,
    deviceValue,
    recordingPreferencesQuery,
    updateRecordingPreferencesMutation,
} from '@/api/devices'
import {Menu, MenuGroup, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator} from '@/components/ui/Menu'
import {toast} from '@/components/ui/toastStore'
import {platform} from '@/lib/platform'
import {switchDevice} from '../store/runtime'
import {useSessionStore} from '../store/session'

/** The system default, as the radio groups name it; stored as null. */
const DEFAULT = 'default'

interface InputsMenuProps {
    /** The button that opens it. */
    trigger: ReactElement
    /** Opens Settings › Recording, where volumes and chosen apps are. */
    onOpenSettings: () => void
}

/**
 * Change inputs: the microphone and the output whose sound is recorded. While
 * idle a choice is the next recording's; during one the device switches at
 * once, and if it cannot, the old one keeps recording. Either way the choice
 * is stored (Settings › Recording shows the same). A saved device that is
 * not connected shows the default checked, which a recording opens, and is
 * named beside it. macOS records the current output, so it offers no output
 * choice.
 */
export function InputsMenu({trigger, onOpenSettings}: InputsMenuProps) {
    const phase = useSessionStore((state) => state.phase)
    const devices = useQuery(audioDevicesQuery)
    const preferences = useQuery(recordingPreferencesQuery)
    const update = useMutation(updateRecordingPreferencesMutation())
    const live = phase === 'recording' || phase === 'paused'

    const inputs = devices.data?.filter((device) => device.device_type === 'Input') ?? []
    const outputs = devices.data?.filter((device) => device.device_type === 'Output') ?? []
    const mic = deviceInUse(preferences.data?.preferred_mic_device, devices.data)
    const output = deviceInUse(preferences.data?.preferred_system_device, devices.data)
    const systemDefault = (missing: string | null) => (missing ? `System default (${missing} isn’t connected)` : 'System default')

    const choose = async (kind: 'mic' | 'system', value: string) => {
        const device = [...inputs, ...outputs].find((each) => deviceValue(each) === value)
        if (live && device && !(await switchDevice(device))) return
        const stored = value === DEFAULT ? null : value
        update.mutate(kind === 'mic' ? {preferred_mic_device: stored} : {preferred_system_device: stored}, {
            onError: (error) => toast.error('Could not keep the choice for the next recording', {description: error.message}),
        })
    }

    const options = (list: AudioDevice[]) => list.map((device) => (
        <MenuRadioItem key={deviceValue(device)} value={deviceValue(device)}>{device.name}</MenuRadioItem>
    ))

    return (
        <Menu trigger={trigger} side="top" align="start">
            <MenuGroup label="Microphone">
                {/* Why the list is empty, when it could not be read (#216). */}
                {devices.isError && <MenuItem onSelect={() => undefined} disabled>{devices.error.message}</MenuItem>}
                <MenuRadioGroup value={mic.device ?? DEFAULT} onValueChange={(value) => void choose('mic', value)}>
                    {/* The default cannot be switched to mid-recording: native needs a device's name. */}
                    <MenuRadioItem value={DEFAULT} disabled={live}>{systemDefault(mic.missing)}</MenuRadioItem>
                    {options(inputs)}
                </MenuRadioGroup>
            </MenuGroup>
            {platform !== 'macos' && (
                <MenuGroup label="Computer audio">
                    <MenuRadioGroup value={output.device ?? DEFAULT} onValueChange={(value) => void choose('system', value)}>
                        <MenuRadioItem value={DEFAULT} disabled={live}>{systemDefault(output.missing)}</MenuRadioItem>
                        {options(outputs)}
                    </MenuRadioGroup>
                </MenuGroup>
            )}
            <MenuSeparator/>
            <MenuItem icon={<GearIcon size={15}/>} onSelect={onOpenSettings}>Recording settings</MenuItem>
        </Menu>
    )
}
