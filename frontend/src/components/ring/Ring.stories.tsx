import type {Meta, StoryObj} from '@storybook/react-vite'
import styled from 'styled-components'
import {type LevelFeed, useAudioLevelMonitoring} from '@/api/audio'
import {Ring, type RingMode} from './Ring'
import {StaticRing} from './StaticRing'
import {useMockLevel} from './storyLevels'

const MODES: RingMode[] = ['rec', 'test', 'idle', 'paused']

// What each mode follows in the app: the recording ring both sources of the
// recording, the mic test the microphone's preview. The mock fakes both.
const FEEDS: Partial<Record<RingMode, LevelFeed>> = {
    rec: {kind: 'recording', source: 'both'},
    test: {kind: 'device', type: 'input'},
}

interface RingDemoProps {
    mode: RingMode
    /** Width and height in CSS pixels. */
    size: number
    /** Holds the fake audio at this level, 0 to 1; unset plays a fake conversation. */
    level?: number
}

function RingDemo({mode, size, level}: RingDemoProps) {
    useMockLevel(level)
    useAudioLevelMonitoring(mode === 'test' ? [] : null)
    return <Ring mode={mode} size={size} level={FEEDS[mode]}/>
}

const Row = styled.div`
    display: flex;
    align-items: flex-end;
    gap: ${({theme}) => theme.space[6]};
`

const Cell = styled.figure`
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: ${({theme}) => theme.space[2]};
    margin: 0;
`

const Caption = styled.figcaption`
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.muted};
`

// The sizes the design uses: the minibar, the recording bar, the mic test,
// first launch, and a large one.
const SIZES = [48, 56, 72, 96, 128]

const meta = {
    title: 'Ring/Ring',
    component: RingDemo,
    args: {mode: 'rec', size: 96},
    argTypes: {
        mode: {control: 'inline-radio', options: MODES},
        size: {control: {type: 'range', min: 24, max: 256, step: 4}},
        level: {control: {type: 'range', min: 0, max: 1, step: 0.01}},
    },
} satisfies Meta<typeof RingDemo>

export default meta

type Story = StoryObj<typeof meta>

/** Recording: the edge follows the fake conversation of both sources. */
export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}

/** Drag `level` in Controls; clear it to go back to the fake conversation. */
export const LevelSlider: Story = {args: {level: 0.5}}

/** The mic test: livelier, following the microphone's preview. */
export const MicTest: Story = {args: {mode: 'test', size: 72}}

/** Ready, on first launch: greyed and slow, it does not listen. */
export const Idle: Story = {args: {mode: 'idle', size: 96}}

/** Flat and grey; the highlight still creeps. */
export const Paused: Story = {args: {mode: 'paused', size: 56}}

function AllModes({size}: { size: number }) {
    return (
        <Row>
            {MODES.map((mode) => (
                <Cell key={mode}>
                    <RingDemo mode={mode} size={size}/>
                    <Caption>{mode}</Caption>
                </Cell>
            ))}
        </Row>
    )
}

/** Every mode side by side; switching a mode on one ring eases into it. */
export const Modes: Story = {render: () => <AllModes size={96}/>}

export const ModesDark: Story = {globals: {theme: 'dark'}, render: () => <AllModes size={96}/>}

function AllSizes() {
    return (
        <Row>
            {SIZES.map((size) => (
                <Cell key={size}>
                    <RingDemo mode="rec" size={size}/>
                    <Caption>{size} px</Caption>
                </Cell>
            ))}
        </Row>
    )
}

export const Sizes: Story = {render: () => <AllSizes/>}

export const SizesDark: Story = {globals: {theme: 'dark'}, render: () => <AllSizes/>}

const StaticBox = styled.span<{ $size: number }>`
    position: relative;
    width: ${({$size}) => $size}px;
    height: ${({$size}) => $size}px;
`

function StaticModes() {
    return (
        <Row>
            {MODES.map((mode) => (
                <Cell key={mode}>
                    <StaticBox $size={72}><StaticRing mode={mode} size={72}/></StaticBox>
                    <Caption>{mode}</Caption>
                </Cell>
            ))}
        </Row>
    )
}

/** What the ring shows without WebGL, or while its context is lost. */
export const WithoutWebgl: Story = {render: () => <StaticModes/>}

export const WithoutWebglDark: Story = {globals: {theme: 'dark'}, render: () => <StaticModes/>}
