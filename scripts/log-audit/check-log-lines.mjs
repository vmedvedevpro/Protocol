#!/usr/bin/env node
// Keeps meeting content and secrets out of Protocol's log (#234).
//
// Reads every log and print macro call in the native sources, over several
// lines too, and fails on a value whose name says it carries a transcript, a
// summary, notes, a prompt, a model's reply, a key or a token: an argument
// after the format string, a name inlined in it (`{text}`), or a name bound
// earlier in the file with `let line = format!(…)` from such a value. Literal
// text is not checked: only values change from meeting to meeting.
//
// A reviewed line that only looks like one is written so the checker sees
// that (`text.len()`, `response.status()`), or carries
// `// log-audit: <reason>` on the line above the macro or on its first line.
//
//   node scripts/log-audit/check-log-lines.mjs [source folder…]

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

const MACROS = /\b(?:(?:log::)?(?:info|warn|error|debug|trace|log_info|log_warn|log_error|log_debug|log_trace|perf_debug|perf_trace|async_info|async_warn|async_debug)|log::log|eprintln|println|dbg)!\s*\(/g
/** A test module, whose output goes to the test runner and never to the log. */
const TEST_MODULE = /#\[cfg\((?:all\()?test\b[^\]]*\]\s*(?:pub(?:\([a-z]+\))?\s+)?mod\s+\w+\s*\{/g
const FORMATTED_LET = /\blet\s+(?:mut\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*format!\s*\(/g

/** Last name parts that carry meeting content or secrets. */
const DENIED = new Set([
    'text', 'texts', 'transcript', 'transcripts', 'segment', 'segments', 'summary', 'summaries',
    'note', 'notes', 'prompt', 'prompts', 'response', 'responses', 'reply', 'replies', 'body',
    'content', 'contents', 'completion', 'completions', 'answer', 'markdown', 'utterance', 'words',
    'message', 'messages', 'msg', 'output', 'outputs', 'preview',
    'secret', 'secrets', 'password', 'authorization', 'credential', 'credentials', 'token',
])
/** `api_key`, `openai_key`, `apiKey`; a bare `key` is usually a map's. */
const KEY = /(?:^|_)(?:api|secret|access|private|openai|anthropic|groq|openrouter)_?key$/

/** Calls that pass a value's content on: `text.chars().take(50).collect()` is still text. */
const PASS_THROUGH = new Set([
    'chars', 'take', 'skip', 'collect', 'to_string', 'to_owned', 'clone', 'as_str', 'as_ref', 'as_deref',
    'trim', 'trim_start', 'trim_end', 'lines', 'join', 'iter', 'into_iter', 'map', 'unwrap', 'unwrap_or',
    'unwrap_or_default', 'expect', 'get', 'first', 'last', 'to_lowercase', 'to_uppercase', 'concat',
    'replace', 'split', 'escape_debug', 'lock', 'read', 'borrow',
])

/** Leading parts that make a name a number: `num_segments`, `total_segments`. */
const COUNTS = new Set(['num', 'total', 'count', 'n', 'max', 'min', 'last', 'first'])

/**
 * A name carries content when its last part says so: `segment_text` and
 * `access_token` do, `segment_index`, `prompt_tokens` and `transcripts_dir`
 * do not.
 */
export function denied(name) {
    const parts = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split('_').filter(Boolean)
    if (parts.length > 1 && COUNTS.has(parts[0])) return false
    return DENIED.has(parts.at(-1)) || KEY.test(parts.join('_'))
}

/** The source with string and char literals and comments blanked, offsets kept. */
function blankLiterals(source) {
    const out = source.split('')
    const blank = (from, to) => {
        for (let index = from; index < to; index++) if (out[index] !== '\n') out[index] = ' '
    }
    let index = 0
    while (index < source.length) {
        const rest = source.slice(index, index + 3)
        if (rest.startsWith('//')) {
            const end = source.indexOf('\n', index)
            const stop = end === -1 ? source.length : end
            blank(index, stop)
            index = stop
        } else if (rest.startsWith('/*')) {
            const end = source.indexOf('*/', index + 2)
            const stop = end === -1 ? source.length : end + 2
            blank(index, stop)
            index = stop
        } else if (/^r#*"/.test(source.slice(index, index + 20)) && !/[A-Za-z0-9_]/.test(source[index - 1] ?? '')) {
            const hashes = source.slice(index + 1).match(/^#*/)[0]
            const open = index + 1 + hashes.length
            const close = source.indexOf(`"${hashes}`, open + 1)
            const stop = close === -1 ? source.length : close + 1 + hashes.length
            blank(open + 1, stop - 1 - hashes.length)
            index = stop
        } else if (source[index] === '"') {
            let end = index + 1
            while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1
            blank(index + 1, end)
            index = end + 1
        } else if (source[index] === "'" && /^'(\\.|[^\\'])'/u.test(source.slice(index, index + 4))) {
            // A char literal; a lifetime (`'a`) has no closing quote and is skipped.
            const end = source.indexOf("'", index + 2)
            blank(index + 1, end)
            index = end + 1
        } else {
            index++
        }
    }
    return out.join('')
}

/** Every call `pattern` opens: its offsets and its argument text, raw and with literals blanked. */
function calls(source, blanked, pattern) {
    return [...blanked.matchAll(pattern)].map((match) => {
        const open = match.index + match[0].length
        let depth = 1
        let close = open
        while (close < blanked.length && depth > 0) {
            if ('([{'.includes(blanked[close])) depth++
            else if (')]}'.includes(blanked[close])) depth--
            close++
        }
        return {at: match.index, end: close, name: match[1], raw: source.slice(open, close - 1), code: blanked.slice(open, close - 1)}
    })
}

/** The names a call uses that carry meeting content or secrets, `tainted` ones included. */
function deniedValues(call, tainted) {
    const isDenied = (name) => denied(name) || tainted.has(name)
    const found = new Set()
    // Names inlined in the format string: `{text}`, `{text:?}`.
    for (const literal of call.raw.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
        for (const inline of literal[1].matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g)) {
            if (isDenied(inline[1])) found.add(inline[1])
        }
    }
    // Values: each path such as `segment.text`, `self.api_key` or
    // `response.status()` is judged by its last part that is not a
    // pass-through call: `segment.text.chars().take(50)` is text,
    // `response.status()` and `segment.sequence_id` are not. `target: "…"` is
    // not a value.
    const code = call.code.replace(/\btarget\s*:/, ' ')
    for (const path of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\s*(?:\.|::)\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\([^()]*\))?)*/g)) {
        const parts = path[0].split(/\s*(?:\.|::)\s*/).map((part) => part.replace(/\s*\(.*$/s, ''))
        const deciding = [...parts].reverse().find((part) => !PASS_THROUGH.has(part))
        if (deciding && isDenied(deciding)) found.add(parts.join('.'))
    }
    return [...found]
}

export function checkSource(source) {
    let blanked = blankLiterals(source)
    for (const {at, end} of calls(source, blanked, TEST_MODULE)) {
        blanked = blanked.slice(0, at) + blanked.slice(at, end).replace(/[^\n]/g, ' ') + blanked.slice(end)
    }
    const lines = source.split('\n')
    const starts = [0]
    for (const line of lines) starts.push(starts.at(-1) + line.length + 1)
    /** The 1-based line of an offset. */
    const lineOf = (at) => {
        let low = 0
        let high = lines.length - 1
        while (low < high) {
            const middle = Math.ceil((low + high) / 2)
            if (starts[middle] <= at) low = middle
            else high = middle - 1
        }
        return low + 1
    }
    const marked = (line) => /\/\/\s*log-audit:/.test(`${lines[line - 2] ?? ''}\n${lines[line - 1]}`)

    const tainted = new Set()
    for (const call of calls(source, blanked, FORMATTED_LET)) {
        if (deniedValues(call, tainted).length > 0) tainted.add(call.name)
    }
    return calls(source, blanked, MACROS)
        .map((call) => ({line: lineOf(call.at), values: deniedValues(call, tainted)}))
        .filter(({line, values}) => values.length > 0 && !marked(line))
}

function rustFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) return rustFiles(path)
        return name.endsWith('.rs') ? [path] : []
    })
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    const dirs = process.argv.length > 2 ? process.argv.slice(2) : [join(root, 'frontend/src-tauri/src')]
    let failures = 0
    for (const file of dirs.flatMap(rustFiles)) {
        for (const {line, values} of checkSource(readFileSync(file, 'utf8'))) {
            failures++
            console.error(`${relative(root, file)}:${line}: logs ${values.join(', ')}`)
        }
    }
    if (failures > 0) {
        console.error(
            `\n${failures} log line(s) can carry meeting content or secrets. Log a length, count or status instead, ` +
                'or mark a reviewed line with `// log-audit: <reason>` (scripts/log-audit/check-log-lines.mjs).',
        )
        process.exit(1)
    }
    console.log('Log lines carry no meeting content or secrets.')
}
