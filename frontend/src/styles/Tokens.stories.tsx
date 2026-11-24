import {useState} from 'react'
import type {Meta, StoryObj} from '@storybook/react-vite'
import type {Transition} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {useTheme} from 'styled-components'
import {cubicBezier, durations, easings, springs, tween} from './motion'
import type {AppTheme} from './theme'

const Sheet = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[8]};
    width: 640px;
    padding: ${({theme}) => theme.space[6]};
    background: ${({theme}) => theme.colors.bg};
`

const Group = styled.section`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[3]};
`

const Heading = styled.h2`
    ${({theme}) => theme.text.title};
`

const Grid = styled.div`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: ${({theme}) => theme.space[3]};
`

const Token = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1]};
`

const Name = styled.span`
    ${({theme}) => theme.text.small};
    font-family: ${({theme}) => theme.fonts.mono};
`

const Value = styled.span`
    ${({theme}) => theme.text.caption};
    color: ${({theme}) => theme.colors.muted};
`

const ColorChip = styled.span<{ $token: keyof AppTheme['colors'] }>`
    height: ${({theme}) => theme.sizes.control.lg};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme, $token}) => theme.colors[$token]};
`

const TextRow = styled.div`
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: ${({theme}) => theme.space[4]};
    padding-bottom: ${({theme}) => theme.space[2]};
    border-bottom: 1px solid ${({theme}) => theme.colors.border};
`

const TextSample = styled.span<{ $style: keyof AppTheme['text'] }>`
    ${({theme, $style}) => theme.text[$style]};
`

const RadiusBox = styled.span<{ $radius: keyof AppTheme['radii'] }>`
    height: ${({theme}) => theme.sizes.control.lg};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme, $radius}) => theme.radii[$radius]};
    background: ${({theme}) => theme.colors.surface};
`

const SpaceBar = styled.span<{ $space: keyof AppTheme['space'] }>`
    width: ${({theme, $space}) => theme.space[$space]};
    height: ${({theme}) => theme.space[3]};
    background: ${({theme}) => theme.colors.text};
`

const ShadowBox = styled.span<{ $shadow: keyof AppTheme['shadows'] }>`
    height: ${({theme}) => theme.sizes.control.lg};
    border-radius: ${({theme}) => theme.radii.xl};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme, $shadow}) => theme.shadows[$shadow]};
`

// Motion demo: a dot crosses a fixed track with each token, so durations,
// easings and springs can be compared side by side.
const TRACK = 200
const DOT = 12

const MotionTrack = styled.span`
    position: relative;
    flex: none;
    width: ${TRACK}px;
    height: ${DOT}px;
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.surface};
`

const Dot = styled(m.span)`
    position: absolute;
    top: 0;
    left: 0;
    width: ${DOT}px;
    height: ${DOT}px;
    border-radius: ${({theme}) => theme.radii.pill};
    background: ${({theme}) => theme.colors.text};
`

const PlayButton = styled.button`
    align-self: flex-start;
    height: ${({theme}) => theme.sizes.control.sm};
    padding: 0 ${({theme}) => theme.space[3]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.raised};
    ${({theme}) => theme.text.small};
    cursor: pointer;
`

function MotionRow({label, transition, at}: { label: string; transition: Transition; at: boolean }) {
    return (
        <TextRow>
            <MotionTrack>
                <Dot initial={false} animate={{x: at ? TRACK - DOT : 0}} transition={transition}/>
            </MotionTrack>
            <Value>{label}</Value>
        </TextRow>
    )
}

function MotionTokens() {
    const [at, setAt] = useState(false)
    return (
        <Group>
            <Heading>Motion</Heading>
            <PlayButton type="button" onClick={() => setAt((value) => !value)}>Play</PlayButton>
            {keysOf(durations).map((name) => (
                <MotionRow key={name} at={at} transition={tween(name)} label={`duration.${name} · ${durations[name]}ms, standard`}/>
            ))}
            {keysOf(easings).map((name) => (
                <MotionRow key={name} at={at} transition={tween('slow', name)} label={`easing.${name} · ${cubicBezier(easings[name])}, slow`}/>
            ))}
            {keysOf(springs).map((name) => (
                <MotionRow
                    key={name}
                    at={at}
                    transition={springs[name]}
                    label={`springs.${name} · stiffness ${springs[name].stiffness}, damping ${springs[name].damping}, mass ${springs[name].mass}`}
                />
            ))}
        </Group>
    )
}

function keysOf<T extends object>(record: T) {
    return Object.keys(record) as (keyof T)[]
}

function Tokens() {
    const theme = useTheme()

    return (
        <Sheet>
            <Group>
                <Heading>Colors</Heading>
                <Grid>
                    {keysOf(theme.colors).map((name) => (
                        <Token key={name}>
                            <ColorChip $token={name}/>
                            <Name>{name}</Name>
                            <Value>{theme.colors[name]}</Value>
                        </Token>
                    ))}
                </Grid>
            </Group>

            <Group>
                <Heading>Text</Heading>
                {keysOf(theme.text).map((name) => (
                    <TextRow key={name}>
                        <TextSample $style={name}>Protocol records your meeting</TextSample>
                        <Value>
                            {name} · {theme.text[name].fontSize} / {theme.text[name].lineHeight}
                        </Value>
                    </TextRow>
                ))}
                <TextRow>
                    <TextSample $style="timer" style={{fontFamily: theme.fonts.mono}}>12:04 · 1.2 GB</TextSample>
                    <Value>mono · {theme.fonts.mono}</Value>
                </TextRow>
            </Group>

            <Group>
                <Heading>Radii</Heading>
                <Grid>
                    {keysOf(theme.radii).map((name) => (
                        <Token key={name}>
                            <RadiusBox $radius={name}/>
                            <Name>{name}</Name>
                            <Value>{theme.radii[name]}</Value>
                        </Token>
                    ))}
                </Grid>
            </Group>

            <Group>
                <Heading>Space</Heading>
                {/* Object keys list integers before 0.5, 1.5…; the scale reads in order. */}
                {keysOf(theme.space).sort((a, b) => Number(a) - Number(b)).map((name) => (
                    <TextRow key={name}>
                        <SpaceBar $space={name}/>
                        <Value>space[{name}] · {theme.space[name]}</Value>
                    </TextRow>
                ))}
            </Group>

            <MotionTokens/>

            <Group>
                <Heading>Shadows</Heading>
                <Grid>
                    {keysOf(theme.shadows).map((name) => (
                        <Token key={name}>
                            <ShadowBox $shadow={name}/>
                            <Name>{name}</Name>
                        </Token>
                    ))}
                </Grid>
            </Group>
        </Sheet>
    )
}

const meta = {
    title: 'Foundations/Tokens',
    component: Tokens,
    parameters: {layout: 'fullscreen'},
} satisfies Meta<typeof Tokens>

export default meta

type Story = StoryObj<typeof meta>

export const Light: Story = {globals: {theme: 'light'}}

export const Dark: Story = {globals: {theme: 'dark'}}
