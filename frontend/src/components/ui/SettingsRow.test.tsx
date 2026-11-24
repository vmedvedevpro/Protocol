import {screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {renderUi} from '@/test/renderUi'
import {SettingsGroup, SettingsNavRow, SettingsRow} from './SettingsRow'
import {Switch} from './Switch'
import {TextField} from './TextField'

describe('SettingsRow', () => {
    it('names and describes its control with its own text', () => {
        renderUi(
            <SettingsGroup title="Recording">
                <SettingsRow
                    label="Save audio"
                    description="Keep the recording next to the transcript"
                    control={<Switch checked onCheckedChange={() => {}}/>}
                />
                <SettingsRow label="Your name" control={<TextField size="sm" defaultValue="Tyler"/>}/>
            </SettingsGroup>,
        )

        expect(screen.getByRole('region', {name: 'Recording'})).toBeInTheDocument()
        const toggle = screen.getByRole('switch', {name: 'Save audio'})
        expect(toggle).toHaveAccessibleDescription('Keep the recording next to the transcript')
        expect(screen.getByRole('textbox', {name: 'Your name'})).toHaveValue('Tyler')
    })

    it('opens a subpage from a nav row', async () => {
        const open = vi.fn()
        renderUi(<SettingsNavRow label="Summary model" value="Built-in" onClick={open}/>)

        await userEvent.click(screen.getByRole('button', {name: /Summary model/}))
        expect(open).toHaveBeenCalledOnce()
    })

    it('says that an external row opens in the browser', () => {
        renderUi(<SettingsNavRow label="Report a bug" external onClick={() => {}}/>)

        expect(screen.getByRole('button', {name: 'Report a bug (opens in browser)'})).toBeInTheDocument()
    })
})
