import styled from 'styled-components'

/**
 * Text that assistive technology reads and the eye does not see: the rest of
 * a control's name next to its visible text, or a cue such as "opens in
 * browser". Clipped to nothing rather than hidden, so it stays in the
 * accessible name.
 */
export const VisuallyHidden = styled.span`
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    border: 0;
    white-space: nowrap;
    clip-path: inset(50%);
`
