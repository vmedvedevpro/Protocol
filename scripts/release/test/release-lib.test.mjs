import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FEED_PLATFORMS,
  TAG_PATTERN,
  UPDATER_PAYLOADS,
  VERSION_FILES,
  bumpVersionFiles,
  changelogSection,
  compareVersions,
  cutChangelog,
  feedNotes,
  formatSha256Sums,
  latestJson,
  parseSha256Sums,
  parseVersion,
  readVersionFiles,
  requiredAssets,
  unreleasedSection,
  versionFileErrors,
} from '../release-lib.mjs';
import { repoRoot } from './helpers.mjs';

test('tags are vX.Y.Z or vX.Y.Z-rc.N without leading zeros', () => {
  for (const tag of ['v0.3.0', 'v1.20.3', 'v0.3.0-rc.0', 'v0.3.0-rc.12']) assert.ok(TAG_PATTERN.test(tag), tag);
  for (const tag of ['0.3.0', 'v0.3', 'v01.3.0', 'v0.3.0-rc.01', 'v0.3.0-beta.1', 'v0.3.0-rc', 'v0.3.0\n']) {
    assert.ok(!TAG_PATTERN.test(tag), JSON.stringify(tag));
  }
  assert.deepEqual(parseVersion('0.3.0-rc.2'), { major: 0, minor: 3, patch: 0, rc: 2 });
  assert.equal(parseVersion('0.3.0-rc'), null);
});

test('versions sort numerically and an RC before its release', () => {
  const sorted = ['0.10.0', '0.3.0', '0.3.0-rc.1', '0.3.0-rc.10', '0.3.1', '0.3.0-rc.2'].sort(compareVersions);
  assert.deepEqual(sorted, ['0.3.0-rc.1', '0.3.0-rc.2', '0.3.0-rc.10', '0.3.0', '0.3.1', '0.10.0']);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
});

test('the four version files of this checkout agree', () => {
  const found = readVersionFiles(repoRoot);
  assert.deepEqual(versionFileErrors(found, found.tauriConf), []);
  assert.match(versionFileErrors({ ...found, cargoLock: '9.9.9' }, found.tauriConf)[0], /^Cargo\.lock has version 9\.9\.9/);
});

const changelog = [
  '# Changelog',
  '',
  '## Protocol — unreleased',
  '',
  '- Next change.',
  '',
  '## Protocol 0.3.0 — 2026-10-30',
  '',
  'Intro.',
  '',
  '- First change.',
  '',
  '## Unreleased',
  '',
  '- Upstream text.',
  '',
].join('\n');

test('a release section ends at the next heading and upstream headings never match', () => {
  assert.deepEqual(changelogSection(changelog, '0.3.0'), { count: 1, body: 'Intro.\n\n- First change.' });
  assert.deepEqual(changelogSection(changelog, '0.3.1'), { count: 0, body: '' });
  assert.deepEqual(changelogSection(changelog.replace('0.3.0 — 2026-10-30', '0.3.0'), '0.3.0').count, 1);
  assert.equal(changelogSection(`${changelog}\n## Protocol 0.3.0\n\n- Again.\n`, '0.3.0').count, 2);
  assert.equal(changelogSection(changelog.replace('0.3.0', '0x3x0'), '0.3.0').count, 0, 'dots are literal');
  assert.deepEqual(unreleasedSection(changelog), { count: 1, body: '- Next change.' });
});

test('cutting the changelog dates the unreleased section and opens a new one', () => {
  const cut = cutChangelog(changelog.replace(/\n/g, '\r\n'), '0.3.1', '2026-11-02');
  assert.ok(cut.includes('\r\n## Protocol — unreleased\r\n\r\n## Protocol 0.3.1 — 2026-11-02\r\n\r\n- Next change.\r\n'));
  assert.equal(changelogSection(cut, '0.3.1').body, '- Next change.');
  assert.equal(unreleasedSection(cut).body, '');
  assert.throws(() => cutChangelog(changelog, '0.3.0', '2026-11-02'), /already has a section/);
  assert.throws(() => cutChangelog(changelog, '0.3.1', '02.11.2026'), /invalid date/);
  assert.throws(() => cutChangelog('# Changelog\n', '0.3.1', '2026-11-02'), /exactly one/);
});

test('the bump changes only the version of each file', () => {
  const texts = Object.fromEntries(
    Object.entries(VERSION_FILES).map(([key, path]) => [key, readFileSync(join(repoRoot, path), 'utf8')]),
  );
  const old = readVersionFiles(repoRoot).tauriConf;
  const bumped = bumpVersionFiles(texts, '9.8.7-rc.6');
  for (const key of Object.keys(VERSION_FILES)) {
    const before = texts[key].split(/\r?\n/);
    const after = bumped[key].split(/\r?\n/);
    assert.equal(after.length, before.length, key);
    const changed = after.filter((line, index) => line !== before[index]);
    assert.equal(changed.length, 1, `${key}: ${changed.join(' | ')}`);
    assert.ok(changed[0].includes('9.8.7-rc.6') && before.some((line) => line.includes(old)), key);
  }
  assert.equal(JSON.parse(bumped.tauriConf).version, '9.8.7-rc.6');
  assert.throws(() => bumpVersionFiles(texts, '9.8'), /invalid version/);
});

test('every updater payload has a .sig and a feed entry, and the deb has none', () => {
  const assets = requiredAssets('0.3.0');
  assert.deepEqual(assets, [
    'SHA256SUMS.txt',
    'latest.json',
    'protocol-linux-x86_64.AppImage',
    'protocol-linux-x86_64.AppImage.sig',
    'protocol-macos-arm64.app.tar.gz',
    'protocol-macos-arm64.app.tar.gz.sig',
    'protocol-macos-arm64.dmg',
    'protocol-windows-x64-setup.exe',
    'protocol-windows-x64-setup.exe.sig',
    'protocol_0.3.0_amd64.deb',
  ]);
  assert.deepEqual([...new Set(Object.values(FEED_PLATFORMS))].sort(), [...UPDATER_PAYLOADS].sort());
  assert.ok(!Object.keys(FEED_PLATFORMS).some((key) => key === 'linux-x86_64' || key.endsWith('-deb')));
});

test('latest.json has tag-specific URLs, the signatures and the notes', () => {
  const signatures = Object.fromEntries(UPDATER_PAYLOADS.map((name) => [name, `sig-of-${name}\n`]));
  const feed = latestJson({ version: '0.3.0', notes: '- Change.', pubDate: '2026-10-30T12:00:00Z', signatures });
  assert.equal(feed.version, '0.3.0');
  assert.equal(feed.pub_date, '2026-10-30T12:00:00Z');
  assert.equal(feed.notes, '- Change.');
  assert.deepEqual(Object.keys(feed.platforms).sort(), Object.keys(FEED_PLATFORMS).sort());
  assert.deepEqual(feed.platforms['windows-x86_64'], {
    signature: 'sig-of-protocol-windows-x64-setup.exe',
    url: 'https://github.com/vmedvedevpro/Protocol/releases/download/v0.3.0/protocol-windows-x64-setup.exe',
  });
  assert.deepEqual(feed.platforms['windows-x86_64-nsis'], feed.platforms['windows-x86_64']);
  assert.throws(() => latestJson({ version: '0.3.0', notes: '', pubDate: '2026-10-30T12:00:00Z', signatures: {} }), /no signature/);
  assert.throws(() => latestJson({ version: 'v0.3.0', notes: '', pubDate: '2026-10-30T12:00:00Z', signatures }), /invalid version/);
});

test('long feed notes are cut at a boundary and link to the release', () => {
  const notes = Array.from({ length: 400 }, (_, index) => `- Change number ${index} with some words.`).join('\n');
  const cut = feedNotes(notes, '0.3.0', 2000);
  assert.ok(Buffer.byteLength(cut) <= 2000);
  assert.ok(cut.endsWith('[Full release notes](https://github.com/vmedvedevpro/Protocol/releases/tag/v0.3.0)'));
  assert.ok(cut.split('\n\n')[0].split('\n').every((line) => /^- Change number \d+ with some words\.$/.test(line)));
  assert.equal(feedNotes('- Short.', '0.3.0', 2000), '- Short.');
});

test('feed notes without a boundary are cut between code points', () => {
  const link = '\n\n[Full release notes](https://github.com/vmedvedevpro/Protocol/releases/tag/v0.3.0)';
  const budget = 4000 - Buffer.byteLength(link);
  // Halving these 6,002 UTF-16 units would end between the emoji's surrogates.
  const halved = feedNotes(`${'a'.repeat(3000)}😀${'b'.repeat(3000)}`, '0.3.0', 4000);
  // Here the byte budget ends inside the emoji.
  const atBudget = feedNotes(`${'a'.repeat(budget - 2)}😀${'b'.repeat(100)}`, '0.3.0', 4000);
  for (const cut of [halved, atBudget]) {
    assert.ok(cut.isWellFormed(), 'no lone surrogate');
    assert.ok(!JSON.stringify(cut).includes('\\ud83d'));
    assert.ok(Buffer.byteLength(cut) <= 4000);
    assert.ok(cut.endsWith(link));
  }
  assert.ok(halved.startsWith(`${'a'.repeat(3000)}😀b`));
  assert.equal(atBudget, `${'a'.repeat(budget - 2)}${link}`);
});

test('SHA256SUMS lines are sorted GNU format and parse back', () => {
  const hash = (char) => char.repeat(64);
  const text = formatSha256Sums([{ name: 'b.exe', hash: hash('b') }, { name: 'a.dmg', hash: hash('a') }]);
  assert.equal(text, `${hash('a')}  a.dmg\n${hash('b')}  b.exe\n`);
  assert.deepEqual(parseSha256Sums(text).map((entry) => entry.name), ['a.dmg', 'b.exe']);
  assert.throws(() => parseSha256Sums(`${hash('a')}  dir/a.dmg\n`), /invalid/);
  assert.throws(() => parseSha256Sums(`${hash('A')}  a.dmg\n`), /invalid/);
});
