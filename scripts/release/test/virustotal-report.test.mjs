import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient, detections, reportUrl, scannedAssets, summaryMarkdown } from '../virustotal-report.mjs';
import { repoRoot, withTempDir } from './helpers.mjs';

const hash = 'ab'.repeat(32);
const stats = { malicious: 1, suspicious: 1, undetected: 60, harmless: 0, timeout: 2, 'type-unsupported': 10, failure: 1 };

// A fetch stand-in that answers from a list of [method url, status, body] and
// records each call with the fake clock's time.
function fakeApi(responses) {
  const calls = [];
  let now = 0;
  const clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const fetchImpl = async (url, options) => {
    calls.push({ at: now, method: options.method ?? 'GET', url, headers: options.headers, body: options.body });
    const [, status, body] = responses.shift();
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, clock, fetchImpl };
}

test('scans the Windows setup, or with --all every installer and the macOS updater bundle', () => {
  assert.deepEqual(scannedAssets('0.3.0'), ['protocol-windows-x64-setup.exe']);
  assert.deepEqual(scannedAssets('0.3.0', true), [
    'protocol-windows-x64-setup.exe',
    'protocol-macos-arm64.dmg',
    'protocol-macos-arm64.app.tar.gz',
    'protocol-linux-x86_64.AppImage',
    'protocol_0.3.0_amd64.deb',
  ]);
});

test('without VT_API_KEY it writes a notice to the job summary and succeeds', async () => {
  await withTempDir(async (dir) => {
    const summary = join(dir, 'summary.md');
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summary };
    delete env.VT_API_KEY;
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/release/virustotal-report.mjs'), '--tag', 'v0.3.0', '--dir', dir], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^::notice::VirusTotal scan of v0\.3\.0 skipped: the VT_API_KEY secret is not set/m);
    assert.match(readFileSync(summary, 'utf8'), /VT_API_KEY secret is not set/);
  });
});

test('counts malicious and suspicious verdicts out of the engines that gave one', () => {
  assert.deepEqual(detections(stats), { flagged: 2, engines: 62 });
  assert.deepEqual(detections({}), { flagged: 0, engines: 0 });
});

test('writes one row per file with the report link', () => {
  const markdown = summaryMarkdown('v0.3.0', [{ name: 'protocol-windows-x64-setup.exe', hash, stats }]);
  assert.match(markdown, /^### VirusTotal: v0\.3\.0$/m);
  assert.match(markdown, new RegExp(`^\\| \`protocol-windows-x64-setup\\.exe\` \\| 2/62 \\| \\[abababababab…\\]\\(${reportUrl(hash)}\\) \\|$`, 'm'));
});

test('treats an unknown or never analysed file as missing and spaces requests', async (t) => {
  const { calls, clock, fetchImpl } = fakeApi([
    ['GET', 404, { error: { code: 'NotFoundError' } }],
    ['GET', 200, { data: { attributes: { last_analysis_stats: stats, last_analysis_results: {} } } }],
    ['GET', 200, { data: { attributes: { last_analysis_stats: stats, last_analysis_results: { Engine: {} } } } }],
  ]);
  t.mock.method(Date, 'now', clock.now);
  const client = createClient({ apiKey: 'key', fetchImpl, sleep: clock.sleep, spacing: 15_000 });
  assert.equal(await client.fileStats(hash), null);
  assert.equal(await client.fileStats(hash), null);
  assert.deepEqual(await client.fileStats(hash), stats);
  assert.deepEqual(calls.map(({ at }) => at), [0, 15_000, 30_000]);
  assert.equal(calls[0].url, `https://www.virustotal.com/api/v3/files/${hash}`);
  assert.equal(calls[0].headers['x-apikey'], 'key');
});

test('uploads a small file directly and polls the analysis until it completes', async (t) => {
  await withTempDir(async (dir) => {
    const path = join(dir, 'protocol_0.3.0_amd64.deb');
    writeFileSync(path, 'installer');
    const { calls, clock, fetchImpl } = fakeApi([
      ['POST', 200, { data: { type: 'analysis', id: 'analysis-1' } }],
      ['GET', 200, { data: { attributes: { status: 'queued' } } }],
      ['GET', 200, { data: { attributes: { status: 'completed', stats } } }],
    ]);
    t.mock.method(Date, 'now', clock.now);
    const client = createClient({ apiKey: 'key', fetchImpl, sleep: clock.sleep, spacing: 15_000 });
    const id = await client.upload(path, 'protocol_0.3.0_amd64.deb');
    assert.equal(id, 'analysis-1');
    assert.deepEqual(await client.waitForAnalysis(id), stats);
    assert.equal(calls[0].url, 'https://www.virustotal.com/api/v3/files');
    assert.equal(calls[0].body.get('file').name, 'protocol_0.3.0_amd64.deb');
    assert.deepEqual(calls.slice(1).map(({ url }) => url), Array(2).fill('https://www.virustotal.com/api/v3/analyses/analysis-1'));
  });
});

test('reports API errors with the status and body', async () => {
  const { fetchImpl } = fakeApi([['GET', 401, { error: { code: 'WrongCredentialsError' } }]]);
  const client = createClient({ apiKey: 'bad', fetchImpl, sleep: async () => {}, spacing: 0 });
  await assert.rejects(client.fileStats(hash), /HTTP 401 .*WrongCredentialsError/);
});
