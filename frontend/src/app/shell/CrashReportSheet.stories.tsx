import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import type {PendingCrashReport} from '@/api/crashReport'
import {mockState} from '@/mocks/state'
import {CrashReportSheet} from './CrashReportSheet'

const Window = styled.div`
    width: 100vw;
    height: 100vh;
`

const PANIC: PendingCrashReport = {
    reportId: '0123456789abcdef',
    detectedAt: '2026-11-23T18:30:00Z',
    crashType: 'panic',
    appVersion: '0.6.0',
}

const meta = {
    title: 'Shell/CrashReportSheet',
    component: CrashReportSheet,
    parameters: {layout: 'fullscreen'},
    decorators: [(Story) => <Window><Story/></Window>],
    // The mock is reset before each story (preview.tsx); this one left a report.
    beforeEach: () => {
        mockState.crashReport = PANIC
    },
} satisfies Meta<typeof CrashReportSheet>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** The app quit without a panic: power loss, a killed process. */
export const UnexpectedExit: Story = {
    globals: {theme: 'light'},
    beforeEach: () => {
        mockState.crashReport = {...PANIC, crashType: 'unexpected_exit'}
    },
}
