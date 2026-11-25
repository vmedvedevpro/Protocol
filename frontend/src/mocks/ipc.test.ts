import {describe, expect, it, vi} from 'vitest'
import {getAppVersion} from '@/api/app'
import {command, CommandError} from '@/api/core'
import {openExternalUrl} from '@/api/links'
import {getUpdaterStatus} from '@/api/updater'
import packageJson from '../../package.json'
import {handlers, platformHandlers} from './handlers'
import {mockState} from './state'

describe('mock IPC', () => {
    it('answers the shell commands from the in-memory state', async () => {
        await expect(getAppVersion()).resolves.toBe(packageJson.version)
        await expect(getUpdaterStatus()).resolves.toMatchObject({
            currentVersion: packageJson.version,
            support: {kind: 'updatable'},
        })
    })

    it('rejects a command nobody mocked, naming the file to add it to', async () => {
        const call = command('no_such_command')

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

    it('opens http and https links and refuses others, as native does', async () => {
        await openExternalUrl('https://github.com/vmedvedevpro/Protocol')
        await openExternalUrl('http://example.com/')

        expect(mockState.openedUrls).toEqual(['https://github.com/vmedvedevpro/Protocol', 'http://example.com/'])
        await expect(openExternalUrl('file:///C:/Windows')).rejects.toThrow('Only HTTP and HTTPS links can be opened')
        expect(mockState.openedUrls).toHaveLength(2)
    })

    it('rejects open_external_url without a url as Tauri does', async () => {
        await expect(command('open_external_url', {})).rejects.toThrow(
            'invalid args `url` for command `open_external_url`: command open_external_url missing required key url',
        )
    })

    it('answers a platform-only command on the platform the test sets and nowhere else', async () => {
        mockState.platform = 'windows'
        platformHandlers.windows.probe_windows = () => 'answered'
        platformHandlers.macos.probe_macos = () => 'answered'
        try {
            await expect(command('probe_windows')).resolves.toBe('answered')
            // What Tauri replies when generate_handler! left the command out.
            await expect(command('probe_macos')).rejects.toThrow('Command probe_macos not found')
        } finally {
            delete platformHandlers.windows.probe_windows
            delete platformHandlers.macos.probe_macos
        }
    })

    it('refuses to load when a command is in both handlers and platformHandlers', async () => {
        vi.resetModules()
        vi.doMock('./handlers', () => ({
            handlers: {probe_twice: () => null},
            platformHandlers: {windows: {probe_twice: () => null}, macos: {}, linux: {}},
        }))
        try {
            await expect(import('./ipc')).rejects.toThrow('"probe_twice" is in both handlers and platformHandlers')
        } finally {
            vi.doUnmock('./handlers')
        }
    })
})
