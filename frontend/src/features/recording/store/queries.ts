import type {QueryClient} from '@tanstack/react-query'
import {queryClient} from '@/lib/queryClient'

let client: QueryClient = queryClient

/**
 * The store reads and refreshes queries outside React. RecordingRuntime
 * registers the client the app mounts (the app's own, or a test's or a
 * story's), so what the store writes reaches the screens on it.
 */
export function registerQueryClient(next: QueryClient) {
    client = next
}

export const queries = () => client
