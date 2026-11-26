#!/usr/bin/env node
// Keeps meeting content and secrets out of Protocol's log (#234).
//
// Reads every log macro call in the native sources (`log::info!`, `error!`,
// `log_info!`, `perf_debug!` and the rest, over several lines too), and
// fails on a value whose name says it carries a transcript, a summary,
// notes, a prompt, a model's reply, a key or a token. A value is the
// arguments after the format string and the names inlined in it (`{text}`).
// Literal text is not checked: only values change from meeting to meeting.
//
// A reviewed line that only looks like one (a length, a status, a count) is
// written so the checker sees that (`text.len()`, `response.status()`), or
// carries `// log-audit: <reason>` on the line above the macro or on its
// first line.
//
//   node scripts/log-audit/check-log-lines.mjs [source folder…]

import {readdirSync, readFileSync, statSync} from 'node:fs'
import {join, relative} from 'node:path'
import {fileURLToPath} from 'node:url'

const MACROS = /\b(?:log::)?(?:info|warn|error|debug|trace|log_info|log_warn|log_error|log_debug|log_trace|perf_debug|perf_trace)!\s*\(/g

/** Name parts that carry meeting content or secrets. */
const DENIED = new Set([
    'text', 'texts', 'transcript', 'transcripts', 'segment', 'segments', 'summary', 'summaries',
    'note', 'notes', 'prompt', 'prompts', 'response', 'responses', 'reply', 'replies', 'body',
    'content', 'contents', 'completion', 'completions', 'answer', 'markdown', 'utterance', 'words',
    'secret', 'secrets', 'password', 'authorization', 'credential', 'credentials', 'token', 'apikey',
    // `<provider>_key` and the like; a bare `key` is usually a map's.
    'openaikey', 'anthropickey', 'groqkey', 'openrouterkey', 'accesskey', 'privatekey', 'secretkey',
])

/** Calls that pass a value's content on: `text.chars().take(50).collect()` is still text. */
const PASS_THROUGH = new Set([
    'chars', 'take', 'skip', 'collect', 'to_string', 'to_owned', 'clone', 'as_str', 'as_ref', 'as_deref',
    'trim', 'trim_start', 'trim_end', 'lines', 'join', 'iter', 'into_iter', 'map', 'unwrap', 'unwrap_or',
    'unwrap_or_default', 'expect', 'get', 'first', 'last', 'to_lowercase', 'to_uppercase', 'concat',
    'replace', 'split', 'escape_debug', 'display', 'lock', 'read', 'borrow',
])

/** Leading parts that make a name a number: `num_segments`, `total_segments`. */
const COUNTS = new Set(['num', 'total', 'count', 'n', 'max', 'min', 'last', 'first'])

/** Splits `segmentText`, `segment_text` and `SEGMENT_TEXT` into lower-case parts. */
export function nameParts(name) {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .split('_')
        .filter(Boolean)
}

/**
 * A name carries content when its last part says so: `segment_text` and
 * `access_token` do, `segment_index`, `prompt_tokens` and `transcripts_dir`
 * do not. `api_key` counts as `apikey`.
 */
export function denied(name) {
    const parts = nameParts(name)
    if (parts.length > 1 && COUNTS.has(parts[0])) return false
    const last = parts.at(-1)
    const pair = parts.length > 1 ? parts.at(-2) + last : null
    return DENIED.has(last) || (pair !== null && DENIED.has(pair))
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
            const end = source.indexOf("'", index + 2)
            blank(index + 1, end)
            index = end + 1
        } else {
            index++
        }
    }
    return out.join('')
}

/** Every log macro call: its line and its argument text, raw and with literals blanked. */
export function logCalls(source) {
    const blanked = blankLiterals(source)
    const calls = []
    for (const match of blanked.matchAll(MACROS)) {
        const open = match.index + match[0].length
        let depth = 1
        let close = open
        while (close < blanked.length && depth > 0) {
            if ('([{'.includes(blanked[close])) depth++
            else if (')]}'.includes(blanked[close])) depth--
            close++
        }
        calls.push({
            index: match.index,
            line: source.slice(0, match.index).split('\n').length,
            raw: source.slice(open, close - 1),
            code: blanked.slice(open, close - 1),
        })
    }
    return calls
}

/** The names a call logs that carry meeting content or secrets. */
export function deniedValues(call) {
    const found = new Set()
    // Names inlined in the format string: `{text}`, `{text:?}`.
    for (const literal of call.raw.matchAll(/"((?:\\.|[^"\\])*)"/g)) {
        for (const inline of literal[1].matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}/g)) {
            if (denied(inline[1])) found.add(inline[1])
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
        if (deciding && denied(deciding)) found.add(parts.join('.'))
    }
    return [...found]
}

function allowed(source, call) {
    const lines = source.split('\n')
    const first = lines[call.line - 1] ?? ''
    const above = lines[call.line - 2] ?? ''
    return /\/\/\s*log-audit:/.test(first) || /\/\/\s*log-audit:/.test(above)
}

export function checkSource(source) {
    return logCalls(source)
        .filter((call) => !allowed(source, call))
        .map((call) => ({line: call.line, values: deniedValues(call)}))
        .filter(({values}) => values.length > 0)
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
        const source = readFileSync(file, 'utf8')
        for (const {line, values} of checkSource(source)) {
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
