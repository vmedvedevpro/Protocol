import {useMutation, useQuery} from '@tanstack/react-query'
import {errorMessage} from '@/api/core'
import {npuOwnsParakeet, npuQuery} from '@/api/intel'
import {type NativeLab, nativeLabQuery, setLab, setNativeLabMutation, useLab, type WebViewLab} from '@/api/labs'
import {SettingsGroup, SettingsRow} from '@/components/ui/SettingsRow'
import {Switch} from '@/components/ui/Switch'
import {toast} from '@/components/ui/toastStore'
import {platform} from '@/lib/platform'

function WebViewLabRow({lab, label, description}: {lab: WebViewLab, label: string, description: string}) {
    const on = useLab(lab)
    return <SettingsRow label={label} description={description} control={<Switch checked={on} onCheckedChange={(next) => setLab(lab, next)}/>}/>
}

function NativeLabRow({lab, label, description}: {lab: NativeLab, label: string, description: string}) {
    const on = useQuery(nativeLabQuery(lab))
    const change = useMutation(setNativeLabMutation())
    return (
        <SettingsRow
            label={label}
            description={description}
            control={(
                <Switch
                    checked={on.data ?? false}
                    disabled={!on.isSuccess || change.isPending}
                    onCheckedChange={(next) => change.mutate({lab, on: next}, {
                        onError: (error) => toast.error(`Couldn’t change ${label}`, {description: errorMessage(error)}),
                    })}
                />
            )}
        />
    )
}

/**
 * Settings › Advanced › Labs. Parakeet on the GPU is Windows only and does
 * nothing while the Intel NPU runs Parakeet, so it is hidden then.
 */
export function LabsGroup() {
    const npu = useQuery(npuQuery).data
    return (
        <SettingsGroup title="Labs" note="Experiments. They may change or go away.">
            <WebViewLabRow lab="transcriptScrubbing" label="Waveform scrubbing" description="See where people talk in the player and jump there. Adds 0.5× and 0.75×"/>
            <WebViewLabRow lab="cleanTranscript" label="Clean transcript" description="Hide “um” and stutters, and write new summaries from the clean text. The saved transcript stays word for word"/>
            <NativeLabRow lab="voiceProfiles" label="Voice profiles" description="Learn a contact’s voice from their meetings; in later meetings a matching voice gets their name"/>
            <NativeLabRow lab="whisperSilenceGuard" label="Whisper silence guard" description="Stricter about silence and noise, so quiet stretches don’t turn into made-up lines. Very quiet speech may be skipped"/>
            {platform === 'windows' && !(npu && npuOwnsParakeet(npu)) && (
                <NativeLabRow lab="parakeetGpu" label="Parakeet on the GPU" description="Runs Parakeet on the graphics card (DirectML). Stays on the processor if that fails"/>
            )}
        </SettingsGroup>
    )
}
