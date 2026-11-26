import assert from 'node:assert/strict'
import {test} from 'node:test'
import {checkSource, denied} from '../check-log-lines.mjs'

const flagged = (source) => checkSource(source).flatMap(({values}) => values)

test('names that carry content or secrets are denied by their last part', () => {
    for (const name of [
        'text', 'segment_text', 'cleanedText', 'transcript', 'segments', 'summary_markdown', 'api_key', 'apiKey',
        'groq_key', 'openrouterKey', 'access_token', 'body', 'error_body', 'error_msg', 'message', 'output', 'preview',
    ]) {
        assert.equal(denied(name), true, name)
    }
    for (const name of ['segment_index', 'prompt_tokens', 'transcripts_dir', 'num_segments', 'total_segments', 'key', 'cache_key', 'monkey', 'meeting_title', 'error']) {
        assert.equal(denied(name), false, name)
    }
})

test('a logged transcript is found in arguments, inline names and on several lines', () => {
    assert.deepEqual(flagged('info!("chunk {}: {}", chunk.chunk_id, cleaned_text);'), ['cleaned_text'])
    assert.deepEqual(flagged('log::warn!("dropped {text:?}");'), ['text'])
    assert.deepEqual(flagged('log_debug!(\n    "first: {}",\n    first_seg.text.chars().take(50).collect::<String>(),\n);'), ['first_seg.text.chars.take.collect'])
    assert.deepEqual(flagged('perf_trace!("reply {}", response_text);'), ['response_text'])
    assert.deepEqual(flagged('error!("key {}", self.api_key);'), ['self.api_key'])
})

test('every macro that writes a line is read', () => {
    for (const macro of ['async_info!', 'async_warn!', 'async_debug!', 'eprintln!', 'println!']) {
        assert.deepEqual(flagged(`${macro}("{}", text);`), ['text'], macro)
    }
    assert.deepEqual(flagged('log::log!(Level::Info, "{}", text);'), ['text'])
    assert.deepEqual(flagged('dbg!(&summary);'), ['summary'])
})

test('a line built from content with format! is content', () => {
    assert.deepEqual(flagged('let line = format!("{}: {}", kind, message);\nerror!("{line}");'), ['line'])
    assert.deepEqual(flagged('let line = format!("{} chars", text.len());\nerror!("{line}");'), [])
})

test('lengths, statuses and literal text pass', () => {
    assert.deepEqual(flagged('info!("chunk {}: {} chars", id, cleaned_text.chars().count());'), [])
    assert.deepEqual(flagged('warn!("failed with status {} ({} bytes)", response.status(), body.len());'), [])
    assert.deepEqual(flagged('info!("the transcript text and the summary are saved");'), [])
    assert.deepEqual(flagged('info!(target: "webview", "{}", segment.sequence_id);'), [])
})

test('comments, raw strings and chars do not hide or fake a call', () => {
    assert.deepEqual(flagged('let text = x; // info!("{}", text) in a comment'), [])
    assert.deepEqual(flagged('/* info!("{}", text) */'), [])
    assert.deepEqual(flagged('let s = r#"info!("{}", text)"#;'), [])
    // A quote in a char literal, or a lifetime, does not start a string that would swallow the call.
    assert.deepEqual(flagged('let q = \'"\';\ninfo!("{}", text);'), ['text'])
    assert.deepEqual(flagged('fn f<\'a>(x: &\'a str) {\n    info!("{}", text);\n}'), ['text'])
})

test('a test module and a path\'s display pass', () => {
    assert.deepEqual(checkSource('#[cfg(test)]\nmod tests {\n    fn t() { println!("{}", text); }\n}\ninfo!("{}", text);'), [{line: 5, values: ['text']}])
    assert.deepEqual(flagged('info!("merged into {}", output.display());'), [])
})

test('a reviewed line is allowed by its marker', () => {
    assert.deepEqual(flagged('// log-audit: ffmpeg diagnostics only\ndebug!("{}", stderr_text);'), [])
    assert.deepEqual(flagged('debug!("{}", stderr_text); // log-audit: ffmpeg diagnostics only'), [])
})

test('the line number is the macro\'s', () => {
    assert.deepEqual(checkSource('fn a() {}\n\nfn b() {\n    info!(\n        "{}",\n        text\n    );\n}'), [{line: 4, values: ['text']}])
})
