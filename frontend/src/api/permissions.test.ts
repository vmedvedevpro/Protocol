import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {getSystemAudioPermission, openPrivacySettings, probeSystemAudio, systemAudioAllowed} from './permissions'

describe('systemAudioAllowed', () => {
    it('trusts the record, and a heard probe while the record is unread or lags', () => {
        expect(systemAudioAllowed('granted', undefined)).toBe(true)
        expect(systemAudioAllowed('not_determined', true)).toBe(true)
        expect(systemAudioAllowed('unknown', true)).toBe(true)
        expect(systemAudioAllowed('unknown', false)).toBe(false)
        expect(systemAudioAllowed(undefined, undefined)).toBe(false)
    })

    it('lets a denial on record win over an earlier probe', () => {
        expect(systemAudioAllowed('denied', true)).toBe(false)
    })
})

describe('the permission commands on mock IPC', () => {
    it('answer as Windows and Linux do: granted, and a probe that hears at once', async () => {
        mockState.permissions.systemAudio = 'denied'

        expect(await getSystemAudioPermission()).toBe('granted')
        expect(await probeSystemAudio()).toBe(true)
        await expect(openPrivacySettings('Privacy_Microphone')).rejects.toThrow('Command open_system_settings not found')
    })

    it('answer as macOS does: the record, the prompt on the first probe and the privacy panes', async () => {
        mockState.platform = 'macos'
        mockState.permissions.systemAudio = 'not_determined'

        expect(await getSystemAudioPermission()).toBe('not_determined')
        expect(await probeSystemAudio()).toBe(true)
        expect(await getSystemAudioPermission()).toBe('granted')

        await openPrivacySettings('Privacy_AudioCapture')
        expect(mockState.permissions.openedPanes).toEqual(['Privacy_AudioCapture'])
    })
})
