import {Fragment, type ReactNode} from 'react'
import styled from 'styled-components'
import {openLink} from '@/api/links'
import {focusRing} from '@/components/ui/styles'
import {parseReleaseNotes} from './releaseNotes'

const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g

const Link = styled.button`
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;

    ${focusRing};
`

const Code = styled.code`
    font-family: ${({theme}) => theme.fonts.mono};
    font-size: 0.92em;
`

function inline(text: string): ReactNode[] {
    const parts: ReactNode[] = []
    let at = 0
    for (const match of text.matchAll(INLINE)) {
        const [whole, bold, code, label, url] = match
        if (match.index > at) parts.push(text.slice(at, match.index))
        if (bold !== undefined) parts.push(<strong key={match.index}>{inline(bold)}</strong>)
        else if (code !== undefined) parts.push(<Code key={match.index}>{code}</Code>)
        else if (/^https?:\/\//.test(url)) {
            parts.push(
                <Link key={match.index} type="button" onClick={() => openLink(url)}>
                    {label}
                </Link>,
            )
        } else parts.push(label)
        at = match.index + whole.length
    }
    if (at < text.length) parts.push(text.slice(at))
    return parts
}

const Notes = styled.div`
    display: flex;
    flex-direction: column;
    gap: ${({theme}) => theme.space[1.5]};
    ${({theme}) => theme.text.small};
    color: ${({theme}) => theme.colors.soft};

    h3 {
        margin-top: ${({theme}) => theme.space[1]};
        font-size: inherit;
        font-weight: ${({theme}) => theme.fontWeights.semibold};
        color: ${({theme}) => theme.colors.text};
    }

    ul {
        display: flex;
        flex-direction: column;
        gap: ${({theme}) => theme.space[1]};
        margin: 0;
        padding-left: ${({theme}) => theme.space[4]};
    }
`

/** The notes of a release (see parseReleaseNotes), in the app's small text; links open in the browser. */
export function ReleaseNotes({notes}: {notes: string}) {
    return (
        <Notes>
            {parseReleaseNotes(notes).map((block, index) => (
                <Fragment key={index}>
                    {block.kind === 'heading' && <h3>{inline(block.text)}</h3>}
                    {block.kind === 'paragraph' && <p>{inline(block.text)}</p>}
                    {block.kind === 'list' && (
                        <ul>
                            {block.items.map((item, i) => <li key={i}>{inline(item)}</li>)}
                        </ul>
                    )}
                </Fragment>
            ))}
        </Notes>
    )
}
