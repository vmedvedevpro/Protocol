import styled from 'styled-components'

/** A row's buttons side by side. */
export const Actions = styled.div`
    display: flex;
    flex: none;
    align-items: center;
    gap: ${({theme}) => theme.space[1.5]};
`

/** The chosen model's mark in place of its buttons. */
export const InUse = styled.span`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    color: ${({theme}) => theme.colors.text};
`

/** A short field beside a row's label: a length, a number. */
export const NarrowField = styled.div`
    width: 96px;
`
