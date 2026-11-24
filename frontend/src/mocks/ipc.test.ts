import {describe, expect, it, vi} from 'vitest'
import {getAppVersion} from '@/api/app'
import {command, CommandError} from '@/api/core'
import {getUpdaterStatus} from '@/api/updater'
import packageJson from '../../package.json'
import {handlers} from './handlers'
import {mockState} from './state'

describe('mock IPC', () => {
    it('answers the shell commands from the in-memory state', async () => {
        await expect(getAppVersion()).resolves.toBe(packageJson.version)
        await expect(getUpdaterStatus()).resolves.toMatchObject({
            currentVersion: packageJson.version,
            support: {kind: 'off', reason: 'dev'},
        })
    })

    it('rejects a command nobody mocked, naming the file to add it to', async () => {
        const call = command('api_get_meetings')

        await expect(call).rejects.toBeInstanceOf(CommandError)
        await expect(call).rejects.toThrow(/src\/mocks\/handlers\.ts/)
    })

    it('turns a string rejection into an Error with that message, as Rust `Err(String)` arrives', async () => {
        vi.spyOn(handlers, 'updater_get_status').mockImplementation(() => {
            throw 'The updater is still starting'
        })

        await expect(getUpdaterStatus()).rejects.toMatchObject({
            name: 'CommandError',
            command: 'updater_get_status',
            message: 'The updater is still starting',
            detail: 'The updater is still starting',
        })
    })

    it('starts every test from the fixtures', () => {
        expect(mockState.meetings).toHaveLength(12)
        expect(mockState.meetings[0].title).toMatch(/^Weekly Standup — /)
    })
})
