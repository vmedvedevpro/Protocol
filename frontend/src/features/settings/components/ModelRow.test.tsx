import {createElement} from 'react'
import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import type {BuiltInModelStatus, SpeechModelStatus} from '@/api/models'
import {renderSettings} from '../testing'
import {ModelRow} from './ModelRow'

const renderRow = (status: BuiltInModelStatus, onDownload = vi.fn()) => {
    renderSettings(createElement(ModelRow, {
        name: 'Qwen 3.5 4B',
        model: {name: 'qwen3.5:4b', status, size_bytes: 2_740_937_888},
        description: 'Recommended for this computer',
        onDownload,
    }))
    return onDownload
}

describe('ModelRow', () => {
    it('shows a partial built-in download as stopped, with its share and Resume', async () => {
        const onDownload = renderRow({type: 'incomplete', file_size: 687_748_972, expected_size: 2_740_937_888})

        expect(await screen.findByText('Download stopped at 25%')).toBeInTheDocument()
        expect(screen.queryByText('The copy on disk is damaged')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Resume downloading Qwen 3.5 4B'}))
        expect(onDownload).toHaveBeenCalledOnce()
    })

    it('shows an interrupted Whisper download as stopped, with its share and Resume', async () => {
        const onDownload = vi.fn()
        const status: SpeechModelStatus = {Incomplete: {file_size: 5_509_389, expected_size: 539_212_467}}
        renderSettings(createElement(ModelRow, {
            name: 'Whisper Medium Compressed',
            engine: 'whisper',
            model: {name: 'medium-q5_0', status, size_bytes: 539_212_467},
            downloads: {},
            onDownload,
        }))

        expect(await screen.findByText('Download stopped at 1%')).toBeInTheDocument()
        expect(screen.queryByText('The copy on disk is damaged')).not.toBeInTheDocument()
        await userEvent.click(screen.getByRole('button', {name: 'Resume downloading Whisper Medium Compressed'}))
        expect(onDownload).toHaveBeenCalledOnce()
    })

    it('still offers a corrupted copy to download again', async () => {
        renderRow({type: 'corrupted', file_size: 10, expected_min_size: 2_740_937_888})

        expect(await screen.findByText('The copy on disk is damaged')).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Download again Qwen 3.5 4B'})).toBeInTheDocument()
    })
})
