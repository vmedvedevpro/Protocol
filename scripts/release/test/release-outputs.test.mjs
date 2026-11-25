import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { expectedAssets, releaseProblems, setProblems } from '../check-release-assets.mjs';
import { feedProblems, loneSurrogatePaths, publishedPlatforms } from '../check-published-release.mjs';
import { UPDATER_PAYLOADS, formatSha256Sums, latestJson, requiredAssets } from '../release-lib.mjs';
import { renderNotes } from '../render-notes.mjs';
import { SUMS_FILE, checkSums, writeSums } from '../write-sha256sums.mjs';
import { withTempDir } from './helpers.mjs';

// A SHA256SUMS.txt over every asset of `platforms` but itself.
function sumsOf(version, platforms) {
  const names = requiredAssets(version, platforms).filter((name) => name !== 'SHA256SUMS.txt');
  return formatSha256Sums(names.map((name) => ({ name, hash: 'a'.repeat(64) })));
}

test('the release notes link every download and carry the checksums', () => {
  const sums = sumsOf('0.3.0', ['windows', 'macos', 'linux']);
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
  const later = renderNotes({ version: '0.3.1', notes: '- Fix.', sums: sumsOf('0.3.1', ['windows', 'macos', 'linux']) });
  assert.ok(!later.includes('first release') && !later.includes('gh attestation verify'));
  assert.ok(later.includes('blob/v0.3.1/CHANGELOG.md'));
});

test('notes drafted before the macOS build finished say macOS follows', () => {
  const notes = renderNotes({ version: '0.3.0', notes: '- Change.', sums: sumsOf('0.3.0', ['windows', 'linux']) });
  assert.ok(notes.includes('| macOS 14.2+ (Apple Silicon) | Follows when its build finishes | |'));
  assert.ok(!notes.includes('releases/download/v0.3.0/protocol-macos-arm64.dmg'));
  assert.ok(notes.includes('[protocol-windows-x64-setup.exe](') && notes.includes('[protocol_0.3.0_amd64.deb]('));
  assert.throws(() => renderNotes({ version: '0.3.0', notes: '', sums: sumsOf('0.3.0', ['windows', 'macos']) }), /no linux assets/);
  const partial = `${sumsOf('0.3.0', ['windows', 'linux'])}${'b'.repeat(64)}  protocol-macos-arm64.dmg\n`;
  assert.throws(() => renderNotes({ version: '0.3.0', notes: '', sums: partial }), /macos is incomplete/);
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
  assert.deepEqual(expectedAssets('0.3.0', 'legs', ['windows', 'linux']), [
    'protocol-linux-x86_64.AppImage',
    'protocol-windows-x64-setup.exe',
    'protocol_0.3.0_amd64.deb',
  ]);
  assert.deepEqual(expectedAssets('0.3.0', 'signed', ['windows', 'linux']), requiredAssets('0.3.0', ['windows', 'linux']));
  assert.ok(!requiredAssets('0.3.0', ['windows', 'linux']).some((name) => name.includes('macos')));
  assert.deepEqual(expectedAssets('0.3.0', 'joined', ['macos']), [
    'SHA256SUMS.txt',
    'latest.json',
    'protocol-macos-arm64.app.tar.gz',
    'protocol-macos-arm64.app.tar.gz.sig',
    'protocol-macos-arm64.dmg',
  ]);
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

test('a joined platform checks the whole release, draft or published, and its own uploads', () => {
  const local = { 'm.dmg': { size: 3, sha256: 'f'.repeat(64) } };
  const uploaded = { name: 'm.dmg', state: 'uploaded', size: 3, digest: `sha256:${'f'.repeat(64)}` };
  const others = { name: 'w.exe', state: 'uploaded', size: 9, digest: `sha256:${'0'.repeat(64)}` };
  const joined = { draft: false, expected: ['m.dmg', 'w.exe'] };
  assert.deepEqual(releaseProblems({ draft: false, assets: [uploaded, others] }, local, joined), []);
  assert.deepEqual(releaseProblems({ draft: true, assets: [uploaded, others] }, local, joined), []);
  assert.deepEqual(releaseProblems({ draft: false, assets: [{ ...uploaded, size: 4 }] }, local, joined), [
    'release: w.exe is missing',
    'm.dmg: 4 bytes uploaded, 3 local',
  ]);
});

test('a published feed must name this version, its own URLs and the uploaded signatures', () => {
  const signatures = Object.fromEntries(UPDATER_PAYLOADS.map((name) => [name, `sig-${name}\n`]));
  const feed = latestJson({ version: '0.3.0', notes: '', pubDate: '2026-10-30T12:00:00Z', signatures });
  assert.deepEqual(feedProblems(feed, '0.3.0', signatures), []);
  const early = latestJson({ version: '0.3.0', notes: '', pubDate: '2026-10-30T12:00:00Z', signatures, platforms: ['windows', 'linux'] });
  assert.deepEqual(feedProblems(early, '0.3.0', signatures, { platforms: ['windows', 'linux'] }), []);
  assert.deepEqual(feedProblems(early, '0.3.0', signatures), ['latest.json platforms: linux-x86_64-appimage, windows-x86_64, windows-x86_64-nsis']);
  assert.deepEqual(feedProblems(feed, '0.3.0', signatures, { platforms: ['windows', 'linux'] }), [
    'latest.json platforms: darwin-aarch64, darwin-aarch64-app, linux-x86_64-appimage, windows-x86_64, windows-x86_64-nsis',
  ]);
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

test('a published release needs Windows and Linux; macOS may still be on its way', () => {
  assert.deepEqual(publishedPlatforms(sumsOf('0.3.0', ['windows', 'linux']), '0.3.0'), { platforms: ['windows', 'linux'], problems: [] });
  assert.deepEqual(publishedPlatforms(sumsOf('0.3.0', ['windows', 'macos', 'linux']), '0.3.0').platforms, ['windows', 'macos', 'linux']);
  assert.deepEqual(publishedPlatforms(sumsOf('0.3.0', ['windows', 'macos']), '0.3.0').problems, ['SHA256SUMS.txt lists no linux assets']);
  const partial = `${sumsOf('0.3.0', ['windows', 'linux'])}${'b'.repeat(64)}  protocol-macos-arm64.app.tar.gz\n`;
  assert.deepEqual(publishedPlatforms(partial, '0.3.0').problems, [
    'macos is incomplete: protocol-macos-arm64.app.tar.gz.sig, protocol-macos-arm64.dmg missing',
  ]);
});

test('the release notes keep no source wraps inside a paragraph', () => {
  const notes = renderNotes({ version: '0.3.1', notes: '- A change\n  wrapped in the CHANGELOG.', sums: sumsOf('0.3.1', ['windows', 'macos', 'linux']) });
  assert.match(notes, /^- A change wrapped in the CHANGELOG\.$/m);
  assert.match(notes, /you don't need to download them\./);
});
