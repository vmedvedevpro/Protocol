import {useEffect} from 'react'
import {mockState} from '@/mocks/state'

/**
 * For stories: holds the mock's fake audio at `level` (0 to 1) while
 * mounted; undefined plays the fake conversation. Storybook resets the mock
 * before each story.
 */
export function useMockLevel(level: number | undefined) {
    useEffect(() => {
        mockState.audio.level = level ?? null
        return () => {
            mockState.audio.level = null
        }
    }, [level])
}
