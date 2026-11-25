import styled from 'styled-components'

/**
 * A Settings page's own layout: its groups scroll under the head, and a
 * page that saves on Save keeps Cancel and Save below them.
 */
export const SubpageScroll = styled.div`
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

export const SubpageGroups = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[5]};
    padding: ${({theme}) => theme.space[3]} ${({theme}) => theme.space[4]} ${({theme}) => theme.space[6]};
`

export const SubpageFooter = styled.div`
    display: flex;
    flex: none;
    justify-content: flex-end;
    gap: ${({theme}) => theme.space[1.5]};
    padding: ${({theme}) => theme.space[2.5]} ${({theme}) => theme.space[4]};
    border-top: 1px solid ${({theme}) => theme.colors.border};
`

/** The props every page body gets: how to leave it, as Back does. */
export interface SubpageProps {
    back: () => void
}
