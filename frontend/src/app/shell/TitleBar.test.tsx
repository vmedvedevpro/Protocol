import {screen, waitFor, within} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {handlers} from '@/mocks/handlers'
import {renderUi} from '@/test/renderUi'
import {TitleBar, type TitleBarProps} from './TitleBar'

function renderTitleBar(props: Partial<TitleBarProps> & Pick<TitleBarProps, 'platform'>) {
    return renderUi(<TitleBar onTop={false} onTopChange={() => undefined} {...props}/>)
}

describe('TitleBar', () => {
    it('draws the Windows caption buttons, and Maximize follows the window', async () => {
        const minimize = vi.spyOn(handlers, 'plugin:window|minimize')
        const close = vi.spyOn(handlers, 'plugin:window|close')
        renderTitleBar({platform: 'windows'})
        const caption = screen.getByRole('group', {name: 'Window'})

        await userEvent.click(within(caption).getByRole('button', {name: 'Maximize'}))
        expect(await within(caption).findByRole('button', {name: 'Restore'})).toBeInTheDocument()
        await userEvent.click(within(caption).getByRole('button', {name: 'Minimize'}))
        await userEvent.click(within(caption).getByRole('button', {name: 'Close'}))

        expect(minimize).toHaveBeenCalledTimes(1)
        expect(close).toHaveBeenCalledTimes(1)
        expect(screen.getByText('Protocol')).toBeInTheDocument()
        expect(screen.getByRole('banner')).toHaveAttribute('data-tauri-drag-region', 'deep')
    })

    it("leaves the window's chrome to the desktop's frame on Linux", () => {
        renderTitleBar({platform: 'linux', onBack: () => undefined})

        expect(screen.queryByRole('button', {name: 'Close'})).not.toBeInTheDocument()
        expect(screen.queryByRole('button', {name: 'Minimize'})).not.toBeInTheDocument()
        expect(screen.queryByText('Protocol')).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Back to meetings'})).toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Keep on top'})).toBeInTheDocument()
        // The desktop's title bar moves the window; the app's row does not.
        expect(screen.getByRole('banner')).not.toHaveAttribute('data-tauri-drag-region')
    })

    it('offers no pin without a handler (no keep on top in this session)', () => {
        renderUi(<TitleBar platform="linux" onTop={false}/>)

        expect(screen.queryByRole('button', {name: 'Keep on top'})).not.toBeInTheDocument()
    })

    it('leaves the window buttons to macOS', () => {
        renderTitleBar({platform: 'macos'})

        expect(screen.queryByRole('button', {name: 'Close'})).not.toBeInTheDocument()
        expect(screen.queryByText('Protocol')).not.toBeInTheDocument()
        expect(screen.getByRole('button', {name: 'Keep on top'})).toBeInTheDocument()
    })

    it('goes back and toggles the pin', async () => {
        const onBack = vi.fn()
        const onTopChange = vi.fn()
        const {rerender} = renderTitleBar({platform: 'linux', onBack, onTopChange})

        await userEvent.click(screen.getByRole('button', {name: 'Back to meetings'}))
        await userEvent.click(screen.getByRole('button', {name: 'Keep on top'}))
        expect(onBack).toHaveBeenCalledTimes(1)
        expect(onTopChange).toHaveBeenLastCalledWith(true)

        rerender(<TitleBar platform="linux" onTop onTopChange={onTopChange}/>)
        expect(screen.getByRole('button', {name: 'Keep on top'})).toHaveAttribute('aria-pressed', 'true')
        await waitFor(() => expect(screen.queryByRole('button', {name: 'Back to meetings'})).not.toBeInTheDocument())
    })
})
