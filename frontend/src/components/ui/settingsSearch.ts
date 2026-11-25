import {isValidElement, type ReactNode} from 'react'

/** The words of a settings query, lower case. */
export const searchTerms = (query: string) => query.toLocaleLowerCase().split(/\s+/).filter(Boolean)

/** Plain text of a row's parts; a description that is an element (a StatusLine) adds its string children. */
export function textOf(node: ReactNode): string {
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(textOf).join(' ')
    if (isValidElement<{children?: ReactNode}>(node)) return textOf(node.props.children)
    return ''
}

/** Whether every word of the query is in a row's text, ignoring case. */
export function settingsTextMatches(query: string, ...parts: ReactNode[]) {
    const text = parts.map(textOf).join(' ').toLocaleLowerCase()
    return searchTerms(query).every((term) => text.includes(term))
}
