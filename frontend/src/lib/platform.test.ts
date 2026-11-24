import {describe, expect, it} from 'vitest'
import {formatShortcut, platformFromUserAgent} from './platform'

describe('platform', () => {
    it('tells the three webviews apart', () => {
        expect(platformFromUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
        )).toBe('windows')
        expect(platformFromUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
        )).toBe('macos')
        expect(platformFromUserAgent(
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
        )).toBe('linux')
    })

    it('writes shortcuts with ⌘ on macOS and Ctrl elsewhere', () => {
        expect(formatShortcut('K', 'macos')).toBe('⌘K')
        expect(formatShortcut('K', 'windows')).toBe('Ctrl K')
        expect(formatShortcut('R', 'linux')).toBe('Ctrl R')
    })
})
