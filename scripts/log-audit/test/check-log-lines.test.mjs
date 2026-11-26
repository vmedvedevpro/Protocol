import assert from 'node:assert/strict'
import {test} from 'node:test'
import {checkSource, denied} from '../check-log-lines.mjs'

const flagged = (source) => checkSource(source).flatMap(({values}) => values)

test('names that carry content or secrets are denied by their last part', () => {
    for (const name of ['text', 'segment_text', 'cleanedText', 'transcript', 'segments', 'summary_markdown', 'api_key', 'apiKey', 'groq_key', 'access_token', 'body']) {
        assert.equal(denied(name), true, name)
    }
    for (const name of ['segment_index', 'prompt_tokens', 'transcripts_dir', 'num_segments', 'total_segments', 'key', 'cache_key', 'meeting_title', 'error']) {
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

test('lengths, statuses and literal text pass', () => {
    assert.deepEqual(flagged('info!("chunk {}: {} chars", id, cleaned_text.chars().count());'), [])
    assert.deepEqual(flagged('warn!("failed with status {} ({} bytes)", response.status(), body.len());'), [])
    assert.deepEqual(flagged('info!("the transcript text and the summary are saved");'), [])
    assert.deepEqual(flagged('info!(target: "webview", "{}", segment.sequence_id);'), [])
    assert.deepEqual(flagged('let text = x; // info!("{}", text) in a comment'), [])
})

test('a reviewed line is allowed by its marker', () => {
    assert.deepEqual(flagged('// log-audit: ffmpeg diagnostics only\ndebug!("{}", stderr_text);'), [])
    assert.deepEqual(flagged('debug!("{}", stderr_text); // log-audit: ffmpeg diagnostics only'), [])
})

test('the line number is the macro\'s', () => {
    assert.deepEqual(checkSource('fn a() {}\n\nfn b() {\n    info!(\n        "{}",\n        text\n    );\n}'), [{line: 4, values: ['text']}])
})
