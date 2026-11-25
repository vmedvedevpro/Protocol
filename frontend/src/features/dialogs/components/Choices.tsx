import {useId} from 'react'
import styled, {css} from 'styled-components'
import {colorTransition} from '@/components/ui/styles'

export interface Choice<T extends string> {
    value: T
    label: string
    description?: string
    disabled?: boolean
}

interface ChoicesProps<T extends string> {
    /** The group's name, shown as its small heading. */
    legend: string
    choices: readonly Choice<T>[]
    value: T
    onChange: (value: T) => void
    /**
     * `list`: rows on one grey card with a radio dot (Export's content).
     * `grid`: tiles three to a row, the chosen one outlined (Export's format).
     * `plain`: radio dots on the sheet itself (a scope such as "This meeting only").
     */
    layout?: 'list' | 'grid' | 'plain'
}

const Group = styled.fieldset`
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
`

const Legend = styled.legend`
    padding: 0 0 ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.semibold};
    color: ${({theme}) => theme.colors.muted};
`

const Options = styled.div<{ $layout: 'list' | 'grid' | 'plain' }>`
    ${({$layout, theme}) => $layout === 'list' && css`
        overflow: hidden;
        border-radius: ${theme.radii.lg};
        background: ${theme.colors.surface};

        > * + * {
            border-top: 1px solid ${theme.colors.border};
        }
    `}
    ${({$layout, theme}) => $layout === 'grid' && css`
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: ${theme.space[1.5]};
    `}
`

// The native radio, unseen, covers its label: it keeps the keyboard, the
// name and the click; the label draws the look and shows the radio's focus.
const Input = styled.input`
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
`

const Option = styled.label<{ $layout: 'list' | 'grid' | 'plain' }>`
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2.5]};
    color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${colorTransition};

    &:has(${Input}:disabled) {
        color: ${({theme}) => theme.colors.muted};
        cursor: default;
    }

    &:has(${Input}:focus-visible) {
        outline: 2px solid ${({theme}) => theme.colors.text};
        outline-offset: ${({$layout}) => ($layout === 'list' ? '-2px' : '1px')};
    }

    ${({$layout, theme}) => $layout === 'list' && css`
        padding: ${theme.space[2]} ${theme.space[3]};
    `}
    ${({$layout, theme}) => $layout === 'plain' && css`
        gap: ${theme.space[2]};
        padding: ${theme.space[1]} 0;
        border-radius: ${theme.radii.sm};
    `}
    ${({$layout, theme}) => $layout === 'grid' && css`
        display: block;
        padding: ${theme.space[2]} ${theme.space[2.5]};
        border: 1px solid ${theme.colors.border};
        border-radius: ${theme.radii.md};
        background: ${theme.colors.raised};

        &:hover:not(:has(${Input}:disabled)) {
            background: ${theme.colors.surface};
        }

        &:has(${Input}:checked) {
            border-color: ${theme.colors.text};
            background: ${theme.colors.surface};
        }
    `}
`

// The radio's ring and, when chosen, its dot, in the text colour.
const Dot = styled.span`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: ${({theme}) => theme.sizes.radio.size};
    height: ${({theme}) => theme.sizes.radio.size};
    margin-top: ${({theme}) => theme.space[0.5]};
    box-sizing: border-box;
    border: ${({theme}) => theme.sizes.radio.ring} solid ${({theme}) => theme.colors.muted};
    border-radius: 50%;
    ${colorTransition};

    &::after {
        width: ${({theme}) => theme.sizes.radio.dot};
        height: ${({theme}) => theme.sizes.radio.dot};
        border-radius: 50%;
        background: ${({theme}) => theme.colors.text};
        opacity: 0;
        content: '';
        transition: opacity ${({theme}) => theme.motion.duration.fast} ${({theme}) => theme.motion.easing.standard};
    }

    ${Input}:checked + & {
        border-color: ${({theme}) => theme.colors.text};

        &::after {
            opacity: 1;
        }
    }
`

const Text = styled.span`
    flex: 1;
    min-width: 0;
`

const Label = styled.span<{ $strong: boolean }>`
    display: block;
    ${({theme}) => theme.text.body};
    font-weight: ${({theme, $strong}) => ($strong ? theme.fontWeights.medium : theme.fontWeights.regular)};
`

const Description = styled.span<{ $grid: boolean }>`
    display: block;
    ${({theme, $grid}) => ($grid ? theme.text.caption : theme.text.small)};
    color: ${({theme}) => theme.colors.muted};
`

/** One choice of a few, as native radios drawn the design's way. */
export function Choices<T extends string>({legend, choices, value, onChange, layout = 'list'}: ChoicesProps<T>) {
    const name = useId()
    return (
        <Group>
            <Legend>{legend}</Legend>
            <Options $layout={layout}>
                {choices.map((choice) => (
                    <Option key={choice.value} $layout={layout}>
                        <Input
                            type="radio"
                            name={name}
                            value={choice.value}
                            checked={value === choice.value}
                            disabled={choice.disabled}
                            onChange={() => onChange(choice.value)}
                        />
                        {layout !== 'grid' && <Dot aria-hidden/>}
                        <Text>
                            <Label $strong={layout === 'grid'}>{choice.label}</Label>
                            {choice.description && <Description $grid={layout === 'grid'}>{choice.description}</Description>}
                        </Text>
                    </Option>
                ))}
            </Options>
        </Group>
    )
}
