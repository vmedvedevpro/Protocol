import {useEffect} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import type {NativeEvent} from '@/api/events'
import {emitMockEvent} from '@/mocks/ipc'
import {DropOverlay} from './DropOverlay'

const DRAG_ENTER = 'tauri://drag-enter' as NativeEvent<{ paths: string[] }>

/** Files held over the window: the mock sends Tauri's drag-enter once the listener is up. */
function DraggingOver() {
    useEffect(() => {
        const timer = setTimeout(() => void emitMockEvent(DRAG_ENTER, {paths: ['/home/user/call.m4a']}), 100)
        return () => clearTimeout(timer)
    }, [])
    return <DropOverlay/>
}

const meta = {
    title: 'Dialogs/DropOverlay',
    component: DraggingOver,
} satisfies Meta<typeof DraggingOver>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
