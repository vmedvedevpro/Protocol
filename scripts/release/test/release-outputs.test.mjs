import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { expectedAssets, releaseProblems, setProblems } from '../check-release-assets.mjs';
import { feedProblems, loneSurrogatePaths } from '../check-published-release.mjs';
import { UPDATER_PAYLOADS, latestJson, requiredAssets } from '../release-lib.mjs';
import { renderNotes } from '../render-notes.mjs';
import { SUMS_FILE, checkSums, writeSums } from '../write-sha256sums.mjs';
import { withTempDir } from './helpers.mjs';

test('the release notes link every download and carry the checksums', () => {
  const sums = `${'a'.repeat(64)}  protocol-windows-x64-setup.exe\n`;
  const notes = renderNotes({ version: '0.3.0', notes: '- First change.\n', sums, firstRelease: true, attestations: true });
  for (const name of ['protocol-windows-x64-setup.exe', 'protocol-macos-arm64.dmg', 'protocol-linux-x86_64.AppImage', 'protocol_0.3.0_amd64.deb']) {
    assert.ok(notes.includes(`[${name}](https://github.com/vmedvedevpro/Protocol/releases/download/v0.3.0/${name})`), name);
  }
  assert.ok(notes.includes('## What\'s new\n\n- First change.\n\n## Download'));
  assert.ok(notes.includes('This is its first release.'));
  assert.ok(notes.includes(sums.trim()));
  assert.ok(notes.includes('gh attestation verify'));
  assert.ok(notes.includes('only when you click **Download**'), 'updates download on the user\'s click');
  assert.ok(!/updater\.exe|CUDA build/.test(notes));
  assert.ok(!notes.includes('for Windows'), 'the release also ships macOS and Linux');
  const later = renderNotes({ version: '0.3.1', notes: '- Fix.', sums });
  assert.ok(!later.includes('first release') && !later.includes('gh attestation verify'));
  assert.ok(later.includes('blob/v0.3.1/CHANGELOG.md'));
});

test('SHA256SUMS covers every other file and its check finds changes, gaps and leftovers', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'b.exe'), 'bee');
    writeFileSync(join(dir, 'a.dmg'), 'ay');
    await writeSums(dir);
    const lines = readFileSync(join(dir, SUMS_FILE), 'utf8').split('\n');
    assert.deepEqual(lines.map((line) => line.slice(66)), ['a.dmg', 'b.exe', '']);
    assert.deepEqual(await checkSums(dir), []);
    writeFileSync(join(dir, 'b.exe'), 'changed');
    writeFileSync(join(dir, 'c.sig'), 'new');
    assert.deepEqual(await checkSums(dir), ['b.exe: checksum differs', 'c.sig: not listed in SHA256SUMS.txt']);
  });
});

test('a draft must hold exactly the local files, uploaded with matching digests', () => {
  assert.deepEqual(expectedAssets('0.3.0', 'legs'), [
    'protocol-linux-x86_64.AppImage',
    'protocol-macos-arm64.app.tar.gz',
    'protocol-macos-arm64.dmg',
    'protocol-windows-x64-setup.exe',
    'protocol_0.3.0_amd64.deb',
  ]);
  assert.deepEqual(expectedAssets('0.3.0', 'signed'), requiredAssets('0.3.0'));
  assert.deepEqual(setProblems(['a', 'c'], ['a', 'b'], 'dist'), ['dist: b is missing', 'dist: unexpected c']);

  const local = { 'a.exe': { size: 3, sha256: 'f'.repeat(64) } };
  const asset = { name: 'a.exe', state: 'uploaded', size: 3, digest: `sha256:${'f'.repeat(64)}` };
  assert.deepEqual(releaseProblems({ draft: true, assets: [asset] }, local), []);
  assert.deepEqual(releaseProblems({ draft: false, assets: [{ ...asset, state: 'new', size: 2, digest: 'sha256:00' }] }, local), [
    'the release is no longer a draft',
    'a.exe: state new',
    'a.exe: 2 bytes uploaded, 3 local',
    'a.exe: digest sha256:00 differs',
  ]);
  assert.deepEqual(releaseProblems({ draft: true, assets: [] }, local), ['release: a.exe is missing']);
});

test('a published feed must name this version, its own URLs and the uploaded signatures', () => {
  const signatures = Object.fromEntries(UPDATER_PAYLOADS.map((name) => [name, `sig-${name}\n`]));
  const feed = latestJson({ version: '0.3.0', notes: '', pubDate: '2026-10-30T12:00:00Z', signatures });
  assert.deepEqual(feedProblems(feed, '0.3.0', signatures), []);
  const stale = structuredClone(feed);
  stale.version = '0.2.9';
  stale.platforms['windows-x86_64'].url = stale.platforms['windows-x86_64'].url.replace('v0.3.0', 'v0.2.9');
  delete stale.platforms['linux-x86_64-appimage'];
  assert.deepEqual(feedProblems(stale, '0.3.0', { ...signatures, 'protocol-macos-arm64.app.tar.gz': 'other' }), [
    'latest.json says version 0.2.9',
    'latest.json platforms: darwin-aarch64, darwin-aarch64-app, windows-x86_64, windows-x86_64-nsis',
    'windows-x86_64: url https://github.com/vmedvedevpro/Protocol/releases/download/v0.2.9/protocol-windows-x64-setup.exe',
    'darwin-aarch64-app: signature differs from protocol-macos-arm64.app.tar.gz.sig',
    'darwin-aarch64: signature differs from protocol-macos-arm64.app.tar.gz.sig',
  ]);
});

test('a published feed with a lone surrogate is rejected, as the updater would', () => {
  const signatures = Object.fromEntries(UPDATER_PAYLOADS.map((name) => [name, `sig-${name}\n`]));
  const text = JSON.stringify(latestJson({ version: '0.3.0', notes: '- Change.', pubDate: '2026-10-30T12:00:00Z', signatures }));
  // JSON.parse accepts the escape; serde_json does not.
  const broken = JSON.parse(text.replace('- Change.', '- Change \\ud83d.'));
  assert.deepEqual(feedProblems(broken, '0.3.0', signatures), [
    'latest.json.notes: lone UTF-16 surrogate, the updater cannot parse the feed',
  ]);
  assert.deepEqual(feedProblems(JSON.parse(text.replace('- Change.', '- Change \\ud83d\\ude00.')), '0.3.0', signatures), []);
  assert.deepEqual(loneSurrogatePaths({ list: ['ok', '\udc00'], ['\ud800']: 1 }), ['latest.json.list.1', 'latest.json (a key)']);
});
