import {describe, expect, it} from 'vitest'
import {formatModelSize, withSize} from './sizes'

describe('formatModelSize', () => {
    it('says MB below a gigabyte and GB with one decimal above', () => {
        expect(formatModelSize(574_041_195)).toBe('547 MB')
        expect(formatModelSize(1_624_555_275)).toBe('1.5 GB')
    })

    it('says nothing while the size is unknown', () => {
        expect(formatModelSize(null)).toBe('')
        expect(formatModelSize(0)).toBe('')
        expect(withSize('Download', undefined)).toBe('Download')
        expect(withSize('Download', 2 * 1024 * 1024)).toBe('Download · 2 MB')
    })
})
