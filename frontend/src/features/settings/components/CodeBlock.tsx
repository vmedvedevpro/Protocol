import styled from 'styled-components'
import {Button} from '@/components/ui/Button'
import {toast} from '@/components/ui/toastStore'

const Block = styled.div`
    display: flex;
    align-items: flex-start;
    gap: ${({theme}) => theme.space[2]};
`

const Code = styled.pre`
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: ${({theme}) => theme.space[2]} ${({theme}) => theme.space[2.5]};
    overflow-x: auto;
    border: 1px solid ${({theme}) => theme.colors.border};
    border-radius: ${({theme}) => theme.radii.md};
    background: ${({theme}) => theme.colors.raised};
    font-family: ${({theme}) => theme.fonts.mono};
    ${({theme}) => theme.text.small};
    white-space: pre-wrap;
    word-break: break-all;
`

/** Text to paste somewhere else, such as a command, and Copy. */
export function CodeBlock({text, label}: {text: string, label: string}) {
    const copy = () => navigator.clipboard.writeText(text).then(
        () => toast.success('Copied'),
        (error: unknown) => toast.error('Couldn’t copy', {description: String(error)}),
    )
    return (
        <Block>
            <Code aria-label={label}>{text}</Code>
            <Button size="sm" onClick={() => void copy()}>Copy</Button>
        </Block>
    )
}
