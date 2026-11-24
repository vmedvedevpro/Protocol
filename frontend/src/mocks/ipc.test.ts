import {describe, expect, it, vi} from 'vitest'
import {getAppVersion} from '@/api/app'
import {command, CommandError} from '@/api/core'
import {openExternalUrl} from '@/api/links'
import {getUpdaterStatus} from '@/api/updater'
import {platform} from '@/lib/platform'
import packageJson from '../../package.json'
import {handlers, platformHandlers} from './handlers'

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

    it('opens http and https links in the browser and refuses others, as native does', async () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null)

        await openExternalUrl('https://github.com/vmedvedevpro/Protocol')

        expect(open).toHaveBeenCalledWith('https://github.com/vmedvedevpro/Protocol', '_blank', 'noopener')
        await expect(openExternalUrl('file:///C:/Windows')).rejects.toThrow('Only HTTP and HTTPS links can be opened')
    })

    it('answers a platform-only command on its platform and nowhere else', async () => {
        const other = platform === 'windows' ? 'macos' : 'windows'
        platformHandlers[platform].probe_here = () => 'answered'
        platformHandlers[other].probe_elsewhere = () => 'answered'
        try {
            await expect(command('probe_here')).resolves.toBe('answered')
            // What Tauri replies when generate_handler! left the command out.
            await expect(command('probe_elsewhere')).rejects.toThrow('Command probe_elsewhere not found')
        } finally {
            delete platformHandlers[platform].probe_here
            delete platformHandlers[other].probe_elsewhere
        }
    })
})
