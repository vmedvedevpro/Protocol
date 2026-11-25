import {useMutation, useQuery} from '@tanstack/react-query'
import {
    type RecordingPreferencesPatch,
    recordingPreferencesQuery,
    updateRecordingPreferencesMutation,
} from '@/api/devices'
import {toast} from '@/components/ui/toastStore'

/**
 * The stored recording preferences, and `save` for a change to some of them.
 * The value shows the change at once (the mutation is optimistic) and goes
 * back with a toast if native refuses it; `onSaved` runs once it is stored.
 */
export function useRecordingPreferences() {
    const preferences = useQuery(recordingPreferencesQuery)
    const update = useMutation(updateRecordingPreferencesMutation())
    const save = (patch: RecordingPreferencesPatch, onSaved?: () => void) =>
        update.mutate(patch, {
            onSuccess: onSaved,
            onError: (error) => toast.error('Couldn’t save the recording settings', {description: error.message}),
        })
    return {preferences: preferences.data, save}
}
