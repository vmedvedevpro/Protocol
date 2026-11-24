import {QueryClient} from '@tanstack/react-query'

/**
 * A query client for one test. By default Query retries a failed query three
 * times, 1, 2 and 4 s apart, longer than a test waits; here a rejected command
 * shows as an error at once.
 */
export function createTestQueryClient() {
    return new QueryClient({defaultOptions: {queries: {retry: false}}})
}
