import {describe, expect, it} from 'vitest'
import {mockState} from '@/mocks/state'
import {completeOnboarding, ensureDatabase, HOMEBREW_DATABASES} from './onboarding'

const newInstall = () => {
    mockState.database.exists = false
    mockState.onboarding = null
}

describe('ensureDatabase', () => {
    it('leaves an existing database alone', async () => {
        await ensureDatabase('linux')
        expect(mockState.database.setUps).toEqual([])
    })

    it('creates a fresh database on a new install, and first launch can then complete', async () => {
        newInstall()
        await expect(completeOnboarding({summary: {provider: null, model: null, ready: false}, parakeetReady: false}))
            .rejects.toThrow(/state not managed/)

        await ensureDatabase('linux')

        expect(mockState.database.setUps).toEqual(['fresh'])
        await completeOnboarding({summary: {provider: null, model: null, ready: false}, parakeetReady: false})
        expect(mockState.onboarding?.completed).toBe(true)
    })

    it("imports Homebrew's database on macOS, and only there", async () => {
        newInstall()
        mockState.database.homebrewPaths = [HOMEBREW_DATABASES[1]]

        await ensureDatabase('macos')
        expect(mockState.database.setUps).toEqual([`import:${HOMEBREW_DATABASES[1]}`])

        newInstall()
        await ensureDatabase('linux')
        expect(mockState.database.setUps.at(-1)).toBe('fresh')
    })
})
