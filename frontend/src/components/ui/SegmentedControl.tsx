import {useId} from 'react'
import {useMotionValue, useTransform} from 'motion/react'
import * as m from 'motion/react-m'
import styled, {css} from 'styled-components'
import {springs} from '@/styles/motion'

export interface SegmentedOption<T extends string> {
    value: T
    label: string
}

interface SegmentedControlProps<T extends string> {
    /** Names the group for assistive technology. */
    label: string
    options: readonly SegmentedOption<T>[]
    value: T
    onChange: (value: T) => void
}

// The motion follows ddoemonn's Segmented Control on 21st.dev
// (https://21st.dev/@ddoemonn/components/segmented-control), rebuilt on the
// theme. Equal segments (the widest label sets them all) let the thumb move by
// transform alone: translateX(i × 100%) of its own width lands on segment i.

const Track = styled.div<{ $count: number }>`
    position: relative;
    display: inline-grid;
    grid-template-columns: repeat(${({$count}) => $count}, minmax(0, 1fr));
    width: max-content;
    height: ${({theme}) => theme.sizes.control.sm};
    padding: ${({theme}) => theme.space[0.5]};
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.sm};
    background: ${({theme}) => theme.colors.bg};
`

const segmentText = css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 ${({theme}) => theme.space[2.5]};
    ${({theme}) => theme.text.small};
    white-space: nowrap;
`

// A native radio under each segment: arrow keys and focus come from the
// browser, and the shared `name` makes them one group. The thumb lies on top
// and lets the pointer through. It is the only filled shape: hover and press
// change the text colour alone, as in the reference.
const Segment = styled.label<{ $selected: boolean }>`
    position: relative;
    ${segmentText};
    border-radius: ${({theme}) => theme.radii.xs};
    color: ${({theme}) => theme.colors.muted};
    cursor: pointer;
    user-select: none;
    transition: color ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};

    ${({$selected}) => !$selected && css`
        &:hover {
            color: ${({theme}) => theme.colors.text};
        }

        &:active {
            color: ${({theme}) => theme.colors.soft};
        }
    `}

    &:has(input:focus-visible) {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: 1px;
    }

    input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
    }
`

const Thumb = styled(m.span)<{ $count: number }>`
    position: absolute;
    top: ${({theme}) => theme.space[0.5]};
    bottom: ${({theme}) => theme.space[0.5]};
    left: ${({theme}) => theme.space[0.5]};
    width: calc((100% - 2 * ${({theme}) => theme.space[0.5]}) / ${({$count}) => $count});
    overflow: hidden;
    border-radius: ${({theme}) => theme.radii.xs};
    background: ${({theme}) => theme.colors.raised};
    box-shadow: ${({theme}) => theme.shadows.raised};
    pointer-events: none;
`

// Inside the thumb, a copy of every label in the selected colour, moving the
// opposite way, so the copy stays over the labels below: the text under the
// thumb turns to the selected colour as the thumb slides across it.
const ThumbCopy = styled(m.span)`
    position: absolute;
    inset: 0;
`

const ThumbLabels = styled.span<{ $count: number }>`
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    display: grid;
    grid-template-columns: repeat(${({$count}) => $count}, minmax(0, 1fr));
    width: ${({$count}) => $count * 100}%;
    color: ${({theme}) => theme.colors.text};

    span {
        ${segmentText};
    }
`

/**
 * One choice out of a few, with a thumb that slides to it on
 * `springs.snappy`. Under reduced motion the thumb jumps (MotionProvider).
 */
export function SegmentedControl<T extends string>({label, options, value, onChange}: SegmentedControlProps<T>) {
    const name = useId()
    const at = Math.max(options.findIndex((option) => option.value === value), 0)

    // The thumb's own offset drives its copy of the labels, so the two can
    // never drift apart, even when a new choice interrupts the spring.
    const thumbX = useMotionValue(`${at * 100}%`)
    const copyX = useTransform(thumbX, (offset) => `calc(${offset} * -1)`)

    return (
        <Track role="radiogroup" aria-label={label} $count={options.length}>
            {options.map((option) => (
                <Segment key={option.value} $selected={option.value === value}>
                    <input
                        type="radio"
                        name={name}
                        value={option.value}
                        checked={option.value === value}
                        onChange={() => onChange(option.value)}
                    />
                    {option.label}
                </Segment>
            ))}
            <Thumb
                aria-hidden
                $count={options.length}
                style={{x: thumbX}}
                initial={false}
                animate={{x: `${at * 100}%`}}
                transition={springs.snappy}
            >
                <ThumbCopy style={{x: copyX}}>
                    <ThumbLabels $count={options.length}>
                        {options.map((option) => <span key={option.value}>{option.label}</span>)}
                    </ThumbLabels>
                </ThumbCopy>
            </Thumb>
        </Track>
    )
}
