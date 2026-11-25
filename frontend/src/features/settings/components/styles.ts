import styled from 'styled-components'
import {focusRing} from '@/components/ui/styles'

/**
 * A line that needs attention: a failure, or what a choice costs. The window
 * is greyscale, so weight and the text colour mark it.
 */
export const Warning = styled.p`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    color: ${({theme}) => theme.colors.text};
`

/** A slider across a row, its value after it: the volumes, Nemotron's threshold. */
export const SliderLine = styled.div`
    display: flex;
    align-items: center;
    gap: ${({theme}) => theme.space[3]};
`

export const Range = styled.input`
    flex: 1;
    min-width: 0;
    height: ${({theme}) => theme.sizes.control.sm};
    margin: 0;
    background: transparent;
    accent-color: ${({theme}) => theme.colors.text};
    cursor: pointer;
    ${focusRing};
`

export const SliderValue = styled.span`
    flex: none;
    min-width: 4ch;
    ${({theme}) => theme.text.small};
    font-variant-numeric: tabular-nums;
    color: ${({theme}) => theme.colors.muted};
    text-align: right;
`

/** What a row's control shows beside its buttons: "Installed", "In use". */
export const RowValue = styled.span<{$strong?: boolean}>`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme, $strong}) => ($strong ? theme.fontWeights.medium : theme.fontWeights.regular)};
    color: ${({theme, $strong}) => ($strong ? theme.colors.text : theme.colors.muted)};
    white-space: nowrap;
`

/** A row's buttons and value on its right. */
export const RowControls = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`
