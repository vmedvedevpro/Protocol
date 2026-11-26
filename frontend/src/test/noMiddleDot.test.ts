import ts from 'typescript'
import {describe, expect, it} from 'vitest'

/**
 * The interface never joins text with a middle dot (#219): a line's parts
 * go on lines of their own, apart by spacing (SpacedParts), or with a comma
 * or parentheses. This reads every source under src/ the app ships and
 * fails on a dot in a string, a template or JSX text, with its file and
 * line. Comments are not text the app shows, so the parser skips them; so
 * do tests, stories, the mock IPC and the helpers only they use.
 */

const MIDDLE_DOT = '·'

const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {query: '?raw', import: 'default', eager: true})

const shipped = (path: string) =>
    !/\.(test|stories)\.tsx?$/.test(path) && !/\/(mocks|test|testing|stories)\//.test(path) && !path.endsWith('.d.ts')

/** "src/features/x.tsx:12 'Meeting · now'" for each string, template part or JSX text with the dot. */
function middleDots(path: string, text: string): string[] {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const found: string[] = []
    const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node)) {
            if (node.text.includes(MIDDLE_DOT)) {
                const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
                found.push(`${path.replace(/^\.\.\//, 'src/')}:${line} ${JSON.stringify(node.text.trim())}`)
            }
        }
        ts.forEachChild(node, visit)
    }
    visit(file)
    return found
}

describe('interface text', () => {
    it('finds a dot in strings, templates and JSX text, not in comments', () => {
        const source = [
            '// A comment may say "a · b".',
            'const a = "a · b"',
            'const b = `${a} · ${a}`',
            'const c = <p>one · two</p>',
            "const d = '\\u00B7'",
        ].join('\n')
        expect(middleDots('../sample.tsx', source).map((hit) => hit.split(' ')[0])).toEqual([
            'src/sample.tsx:2',
            'src/sample.tsx:3',
            'src/sample.tsx:4',
            'src/sample.tsx:5',
        ])
    })

    it('never joins text with a middle dot', () => {
        const paths = Object.keys(sources).filter(shipped)
        expect(paths.length).toBeGreaterThan(100)
        expect(paths.flatMap((path) => middleDots(path, sources[path]))).toEqual([])
    }, 30_000)
})
