import {renderHook} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {useArrivedIds} from './arrivedIds'

describe('useArrivedIds', () => {
    it('counts the rows that come after the first ones, and one that comes back', () => {
        const {result, rerender} = renderHook(({ids}: { ids?: string[] }) => useArrivedIds(ids), {initialProps: {ids: undefined as string[] | undefined}})
        rerender({ids: ['a', 'b']})
        expect([...result.current]).toEqual([])

        rerender({ids: ['c', 'a', 'b']})
        rerender({ids: ['c', 'b']})
        rerender({ids: ['c', 'a', 'b']})
        expect([...result.current].sort()).toEqual(['a', 'c'])
    })

    it('lets the list change without arrivals while not tracking, and keeps the ones that arrived', () => {
        const {result, rerender} = renderHook(({ids, track}) => useArrivedIds(ids, track), {initialProps: {ids: ['a'], track: true}})
        rerender({ids: ['a', 'b'], track: true})
        rerender({ids: ['a', 'b', 'x'], track: false})
        expect([...result.current]).toEqual(['b'])
    })
})
