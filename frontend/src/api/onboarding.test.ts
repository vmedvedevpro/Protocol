import {describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {mockState} from '@/mocks/state'
import {completeOnboarding, ensureDatabase, HOMEBREW_DATABASES} from './onboarding'

const newInstall = () => {
    mockState.database.exists = false
    mockState.onboarding = null
}

describe('ensureDatabase', () => {
    it('leaves an existing database alone', async () => {
        await expect(ensureDatabase('linux')).resolves.toEqual({importError: null})
        expect(mockState.database.setUps).toEqual([])
    })

    it('creates a fresh database on a new install, and first launch can then complete', async () => {
        newInstall()
        await expect(completeOnboarding({model: 'qwen3.5:4b', parakeetReady: false, summaryReady: false}))
            .rejects.toThrow(/state not managed/)

        await ensureDatabase('linux')

        expect(mockState.database.setUps).toEqual(['fresh'])
        await completeOnboarding({model: 'qwen3.5:4b', parakeetReady: false, summaryReady: false})
        expect(mockState.onboarding?.completed).toBe(true)
    })

    it("imports Meetily's database instead", async () => {
        newInstall()
        mockState.database.legacyPath = '/data/meeting_minutes.db'

        await ensureDatabase('windows')

        expect(mockState.database.setUps).toEqual(['import:/data/meeting_minutes.db'])
    })

    it("imports Homebrew's database first on macOS, and only there", async () => {
        newInstall()
        mockState.database.homebrewPaths = [HOMEBREW_DATABASES[1]]
        mockState.database.legacyPath = '/data/meeting_minutes.db'

        await ensureDatabase('macos')
        expect(mockState.database.setUps).toEqual([`import:${HOMEBREW_DATABASES[1]}`])

        newInstall()
        await ensureDatabase('linux')
        expect(mockState.database.setUps.at(-1)).toBe('import:/data/meeting_minutes.db')
    })

    it('starts with an empty database when the import fails, and says why', async () => {
        newInstall()
        mockState.database.legacyPath = '/data/meeting_minutes.db'
        mockState.database.importError = 'Migration failed: database disk image is malformed'

        await expect(ensureDatabase('linux')).resolves.toEqual({importError: 'Migration failed: database disk image is malformed'})

        expect(mockState.database.setUps).toEqual(['fresh'])
    })

    it('shares one set-up between callers at the same time', async () => {
        newInstall()
        const fresh = vi.spyOn(handlers, 'initialize_fresh_database')

        await Promise.all([ensureDatabase('linux'), ensureDatabase('linux')])

        expect(fresh).toHaveBeenCalledTimes(1)
        expect(mockState.database.setUps).toEqual(['fresh'])
    })
})
