/**
 * A release's notes, as the release feed carries them: its CHANGELOG
 * section. Only what the changelog uses is read: `###` headings, `-` or `*`
 * list items whose lines wrap with an indent, paragraphs, `**bold**`,
 * `` `code` `` and `[links](https://…)`. Anything else stays plain text; no
 * HTML is ever rendered.
 */
export type Block =
    | {kind: 'heading'; text: string}
    | {kind: 'list'; items: string[]}
    | {kind: 'paragraph'; text: string}

export function parseReleaseNotes(notes: string): Block[] {
    const blocks: Block[] = []
    let paragraph: string[] = []
    let list: string[] | null = null

    const endParagraph = () => {
        if (paragraph.length) blocks.push({kind: 'paragraph', text: paragraph.join(' ')})
        paragraph = []
    }
    const endList = () => {
        if (list) blocks.push({kind: 'list', items: list})
        list = null
    }

    for (const raw of notes.split(/\r?\n/)) {
        const line = raw.trim()
        const heading = /^#{1,6}\s+(.*)$/.exec(line)
        const item = /^[-*]\s+(.*)$/.exec(line)
        if (!line) {
            endParagraph()
            endList()
        } else if (heading) {
            endParagraph()
            endList()
            blocks.push({kind: 'heading', text: heading[1]})
        } else if (item) {
            endParagraph()
            list ??= []
            list.push(item[1])
        } else if (list && raw.startsWith(' ')) {
            // An indented line goes on with the item above it.
            list[list.length - 1] += ` ${line}`
        } else {
            endList()
            paragraph.push(line)
        }
    }
    endParagraph()
    endList()
    return blocks
}
