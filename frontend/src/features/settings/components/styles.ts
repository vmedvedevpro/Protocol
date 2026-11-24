import styled from 'styled-components'

/**
 * A line that needs attention: a failure, or what a choice costs. The window
 * is greyscale, so weight and the text colour mark it.
 */
export const Warning = styled.p`
    ${({theme}) => theme.text.small};
    font-weight: ${({theme}) => theme.fontWeights.medium};
    color: ${({theme}) => theme.colors.text};
`
