import {describe, expect, it} from 'vitest'
import type {UpdateError} from '@/api/updater'
import {busySentence, errorSentence, relativeTime, releaseUrl} from './updateText'

const failure = (kind: UpdateError['kind'], message = ''): UpdateError =>
    ({kind, action: 'install', message, at: 0, background: false})

describe('update wording', () => {
    it('says why a restart has to wait', () => {
        expect(busySentence('recording')).toBe("Protocol can't restart while a recording is in progress.")
    })

    it('names the platform and the versions in an error', () => {
        expect(errorSentence(failure('noPlatform'), 'macos')).toBe("A newer version isn't available for macOS yet.")
        expect(errorSentence(failure('installIncomplete'), 'windows', '0.7.0', '0.6.1'))
            .toBe("The update to 0.7.0 didn't finish. Protocol is still on 0.6.1.")
        expect(errorSentence(failure('location'), 'linux')).toMatch(/AppImage/)
    })

    it('links a release by its tag', () => {
        expect(releaseUrl('0.7.0')).toBe('https://github.com/vmedvedevpro/Protocol/releases/tag/v0.7.0')
    })

    it('says how long ago, rounded', () => {
        const now = 10 * 24 * 3600_000
        expect(relativeTime(now - 30_000, now)).toBe('just now')
        expect(relativeTime(now - 60_000, now)).toBe('1 minute ago')
        expect(relativeTime(now - 5 * 3600_000, now)).toBe('5 hours ago')
        expect(relativeTime(now - 24 * 3600_000, now)).toBe('yesterday')
        expect(relativeTime(now - 3 * 24 * 3600_000, now)).toBe('3 days ago')
    })
})
