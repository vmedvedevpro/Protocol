import {useEffect} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import {MotionConfig} from 'motion/react'
import styled from 'styled-components'
import {Button} from './Button'
import {toast} from './toastStore'

const Window = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-content: flex-end;
    justify-content: center;
    gap: ${({theme}) => theme.space[1.5]};
    width: 100vw;
    height: 100vh;
    padding: ${({theme}) => theme.space[6]};
`

// Texts the old app's toasts carried, one per kind the screens need.
function showRecovered() {
    toast.success('Meeting recovered', {
        description: 'Transcript and audio recovered.',
        action: {label: 'Open', onClick: () => undefined},
        duration: 10_000,
    })
}

function showRouteWarning() {
    toast.warning('Computer audio is going to your headphones', {
        description: 'Protocol still records it. Switch outputs in Settings › Recording if the other side is silent.',
        duration: 30_000,
    })
}

function showFailure() {
    toast.error('Download retry failed', {
        description: 'Checksum mismatch: expected 9f1c8d2744e41434484065e2eb1d0f0608f291e5dea2670bba26620ebad3ccde, got 3386357ee861dee1c946ffef14c7c93aad407e27c6cd61fddd7a83d8e4dcf015. The file was deleted.',
    })
}

function showLoading() {
    const id = toast.loading('Identifying speakers…', {description: 'Analyzing the recording on this device.'})
    window.setTimeout(() => toast.success('Found 3 speakers', {id, description: '42 lines labelled.'}), 2000)
}

/**
 * The toasts stay until closed, so each kind can be looked at; the buttons
 * show one more with its own duration.
 */
function Toasts() {
    useEffect(() => {
        toast.info('Downloads continue in the background', {
            description: 'Recording works once the live text model is ready.',
            duration: Infinity,
        })
        toast.error('Summary model download failed', {
            description: 'Check your connection and try again.',
            action: {label: 'Try again', onClick: () => undefined},
            duration: Infinity,
        })
        toast.success('Meeting recovered', {
            description: 'Transcript and audio recovered.',
            action: {label: 'Open', onClick: () => undefined},
            duration: Infinity,
        })
        return () => toast.dismiss()
    }, [])

    return (
        <Window>
            <Button onClick={showRecovered}>Success with an action</Button>
            <Button onClick={showRouteWarning}>Warning, 30 s</Button>
            <Button onClick={showFailure}>Error with hashes</Button>
            <Button onClick={showLoading}>Loading, then done</Button>
            <Button onClick={() => toast('Recording cancelled')}>Plain</Button>
        </Window>
    )
}

const meta = {
    title: 'UI/Toast',
    component: Toasts,
    parameters: {layout: 'fullscreen'},
} satisfies Meta<typeof Toasts>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Reduced motion: toasts only fade in and out. */
export const ReducedMotion: Story = {
    globals: {theme: 'light'},
    decorators: [(Story) => <MotionConfig reducedMotion="always"><Story/></MotionConfig>],
}
