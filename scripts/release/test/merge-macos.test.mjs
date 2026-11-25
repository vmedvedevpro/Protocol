import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { mergeFeed, mergeSums, sameBody } from '../merge-macos.mjs';
import { UPDATER_PAYLOADS, formatSha256Sums, latestJson, requiredAssets } from '../release-lib.mjs';
import { renderNotes } from '../render-notes.mjs';
import { checkSums, writeSums } from '../write-sha256sums.mjs';
import { repoRoot, withTempDir } from './helpers.mjs';

const pubDate = '2026-10-30T12:00:00Z';
const signatures = Object.fromEntries(UPDATER_PAYLOADS.map((name) => [name, `sig-${name}\n`]));
const drafted = (version = '0.3.0') => latestJson({ version, notes: '- Change.', pubDate, signatures, platforms: ['windows', 'linux'] });
const hash = (char) => char.repeat(64);

test('the merged feed is the feed a three-platform release would have', () => {
  const merged = mergeFeed(drafted(), { version: '0.3.0', signature: signatures['protocol-macos-arm64.app.tar.gz'] });
  const full = latestJson({ version: '0.3.0', notes: '- Change.', pubDate, signatures });
  assert.equal(JSON.stringify(merged), JSON.stringify(full), 'same keys in the same order');
  const again = mergeFeed(merged, { version: '0.3.0', signature: 'sig-of-a-rebuild\n' });
  assert.equal(again.platforms['darwin-aarch64'].signature, 'sig-of-a-rebuild');
  assert.deepEqual(again.platforms['darwin-aarch64-app'], again.platforms['darwin-aarch64']);
  assert.deepEqual(again.platforms['windows-x86_64'], full.platforms['windows-x86_64']);
  assert.equal(again.pub_date, pubDate);
});

test('the merge refuses a feed of another release or with entries it does not write', () => {
  const signature = 'sig';
  assert.throws(() => mergeFeed(drafted('0.2.9'), { version: '0.3.0', signature }), /for version 0\.2\.9, not 0\.3\.0/);
  const moved = drafted();
  moved.platforms['windows-x86_64'].url = moved.platforms['windows-x86_64'].url.replace('v0.3.0', 'v0.2.9');
  assert.throws(() => mergeFeed(moved, { version: '0.3.0', signature }), /no windows-x86_64 entry/);
  const noLinux = drafted();
  delete noLinux.platforms['linux-x86_64-appimage'];
  assert.throws(() => mergeFeed(noLinux, { version: '0.3.0', signature }), /no linux-x86_64-appimage entry/);
  const extra = drafted();
  extra.platforms['linux-x86_64'] = extra.platforms['linux-x86_64-appimage'];
  assert.throws(() => mergeFeed(extra, { version: '0.3.0', signature }), /unexpected platform linux-x86_64/);
  assert.throws(() => mergeFeed(drafted(), { version: '0.3.0', signature: ' \n' }), /no signature/);
});

test('the merged checksums add or replace the macOS lines and keep the rest', () => {
  const names = requiredAssets('0.3.0', ['windows', 'linux']).filter((name) => name !== 'SHA256SUMS.txt');
  const before = formatSha256Sums(names.map((name) => ({ name, hash: hash('a') })));
  const entries = ['protocol-macos-arm64.dmg', 'protocol-macos-arm64.app.tar.gz', 'protocol-macos-arm64.app.tar.gz.sig', 'latest.json']
    .map((name) => ({ name, hash: hash('b') }));
  const after = mergeSums(before, entries, '0.3.0');
  const all = requiredAssets('0.3.0').filter((name) => name !== 'SHA256SUMS.txt');
  assert.deepEqual(after.split('\n').filter(Boolean).map((line) => line.slice(66)), all);
  assert.ok(after.includes(`${hash('b')}  latest.json\n`) && !after.includes(`${hash('a')}  latest.json\n`));
  assert.ok(after.includes(`${hash('a')}  protocol-windows-x64-setup.exe\n`));
  assert.equal(mergeSums(after, entries, '0.3.0'), after, 'a re-run with the same files changes nothing');

  assert.throws(() => mergeSums(`${before}${hash('c')}  notes.md\n`, entries, '0.3.0'), /unexpected files: notes\.md/);
  assert.throws(() => mergeSums(before.replace(/^.*AppImage\.sig\n/m, ''), entries, '0.3.0'), /linux is incomplete/);
  const windowsOnly = formatSha256Sums(['protocol-windows-x64-setup.exe', 'protocol-windows-x64-setup.exe.sig', 'latest.json'].map((name) => ({ name, hash: hash('a') })));
  assert.throws(() => mergeSums(windowsOnly, entries, '0.3.0'), /lists no linux assets/);
  assert.throws(() => mergeSums(before.replace('0.3.0_amd64', '0.2.9_amd64'), entries, '0.3.0'), /unexpected files: protocol_0\.2\.9_amd64\.deb/);
});

test('a body is the generated one whatever its line endings', () => {
  assert.ok(sameBody('a\r\nb\r\n', 'a\nb\n\n'));
  assert.ok(!sameBody('a\nb (edited)\n', 'a\nb\n'));
});

// A release folder as the draft job leaves it, built with the real scripts,
// and a signed macOS folder with stand-in files and signature.
async function drafts(dir) {
  const release = join(dir, 'release');
  mkdirSync(release);
  for (const name of ['protocol-windows-x64-setup.exe', 'protocol-linux-x86_64.AppImage', 'protocol_0.3.0_amd64.deb']) {
    writeFileSync(join(release, name), `bytes of ${name}`);
  }
  for (const name of ['protocol-windows-x64-setup.exe', 'protocol-linux-x86_64.AppImage']) writeFileSync(join(release, `${name}.sig`), signatures[name]);
  const notes = join(dir, 'notes-source.md');
  writeFileSync(notes, '- Change.\n');
  const make = spawnSync('node', [join(repoRoot, 'scripts/release/make-latest-json.mjs'), '--version', '0.3.0', '--notes', notes, '--dir', release, '--platforms', 'windows,linux', '--pub-date', pubDate], { encoding: 'utf8' });
  assert.equal(make.status, 0, make.stderr);
  await writeSums(release);
  const body = join(dir, 'body.md');
  writeFileSync(body, renderNotes({ version: '0.3.0', notes: '- Change.\n', sums: readFileSync(join(release, 'SHA256SUMS.txt'), 'utf8'), attestations: true }));
  return { release, notes, body };
}

function macosFolder(dir, name, signature = 'sig-of-the-bundle\n') {
  const macos = join(dir, name);
  mkdirSync(macos);
  writeFileSync(join(macos, 'protocol-macos-arm64.dmg'), 'dmg bytes');
  writeFileSync(join(macos, 'protocol-macos-arm64.app.tar.gz'), 'bundle bytes');
  writeFileSync(join(macos, 'protocol-macos-arm64.app.tar.gz.sig'), signature);
  return macos;
}

function merge({ release, notes, body }, macos, notesOut) {
  return spawnSync('node', [
    join(repoRoot, 'scripts/release/merge-macos.mjs'),
    '--version', '0.3.0', '--release', release, '--dir', macos,
    '--notes', notes, '--body', body, '--notes-out', notesOut, '--attestations',
  ], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });
}

test('macOS joins a drafted release completely, and a re-run joins it again the same way', async () => {
  await withTempDir(async (dir) => {
    const draft = await drafts(dir);
    const first = macosFolder(dir, 'first');
    const run = merge(draft, first, join(dir, 'notes-1.md'));
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readdirSync(first).sort(), [
      'SHA256SUMS.txt',
      'latest.json',
      'protocol-macos-arm64.app.tar.gz',
      'protocol-macos-arm64.app.tar.gz.sig',
      'protocol-macos-arm64.dmg',
    ]);
    const check = spawnSync('node', [join(repoRoot, 'scripts/release/check-release-assets.mjs'), '--version', '0.3.0', '--dir', first, '--platforms', 'macos', '--stage', 'joined'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);

    // The release as it is after the upload: every file in one place.
    const joined = join(dir, 'joined');
    mkdirSync(joined);
    for (const folder of [draft.release, first]) {
      for (const name of readdirSync(folder)) if (name !== 'SHA256SUMS.txt' || folder === first) copyFileSync(join(folder, name), join(joined, name));
    }
    assert.deepEqual(readdirSync(joined).sort(), requiredAssets('0.3.0'));
    assert.deepEqual(await checkSums(joined), [], 'the merged list matches every file of the release');
    const feed = JSON.parse(readFileSync(join(joined, 'latest.json'), 'utf8'));
    assert.equal(feed.platforms['darwin-aarch64'].signature, 'sig-of-the-bundle');
    assert.equal(feed.platforms['darwin-aarch64'].url, 'https://github.com/vmedvedevpro/Protocol/releases/download/v0.3.0/protocol-macos-arm64.app.tar.gz');
    assert.equal(feed.pub_date, pubDate);
    const body = readFileSync(join(dir, 'notes-1.md'), 'utf8');
    assert.ok(body.includes('[protocol-macos-arm64.dmg](https://github.com/vmedvedevpro/Protocol/releases/download/v0.3.0/protocol-macos-arm64.dmg)'));
    assert.ok(body.includes(readFileSync(join(joined, 'SHA256SUMS.txt'), 'utf8').trim()));
    assert.ok(body.includes('gh attestation verify'), 'the flags of the draft carry over');

    // A re-run against the joined release, with a new signature, replaces the
    // macOS entries and renders the body again from the joined one.
    writeFileSync(join(dir, 'body-joined.md'), body.replace(/\n/g, '\r\n'));
    const second = macosFolder(dir, 'second', 'sig-of-a-rebuild\n');
    const rerun = merge({ ...draft, release: joined, body: join(dir, 'body-joined.md') }, second, join(dir, 'notes-2.md'));
    assert.equal(rerun.status, 0, rerun.stderr);
    const refeed = JSON.parse(readFileSync(join(second, 'latest.json'), 'utf8'));
    assert.deepEqual(Object.keys(refeed.platforms), Object.keys(feed.platforms));
    assert.equal(refeed.platforms['darwin-aarch64-app'].signature, 'sig-of-a-rebuild');
    const resums = readFileSync(join(second, 'SHA256SUMS.txt'), 'utf8').split('\n');
    const firstSums = readFileSync(join(first, 'SHA256SUMS.txt'), 'utf8').split('\n');
    const changed = resums.filter((line) => !firstSums.includes(line)).map((line) => line.slice(66));
    assert.deepEqual(changed, ['latest.json', 'protocol-macos-arm64.app.tar.gz.sig'], 'only the new signature and the feed differ');
    assert.ok(readFileSync(join(dir, 'notes-2.md'), 'utf8').includes(resums.join('\n').trim()));
  });
});

test('a body edited by hand is left alone', async () => {
  await withTempDir(async (dir) => {
    const draft = await drafts(dir);
    writeFileSync(draft.body, `${readFileSync(draft.body, 'utf8')}\nA line the owner added.\n`);
    const run = merge(draft, macosFolder(dir, 'macos'), join(dir, 'notes.md'));
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /edited by hand/);
    assert.ok(!existsSync(join(dir, 'notes.md')));
    assert.ok(existsSync(join(dir, 'macos', 'latest.json')), 'the feed and the checksums are merged anyway');
  });
});

test('nothing is written for a feed of another release', async () => {
  await withTempDir(async (dir) => {
    const draft = await drafts(dir);
    writeFileSync(join(draft.release, 'latest.json'), JSON.stringify(drafted('0.2.9')));
    const macos = macosFolder(dir, 'macos');
    const run = merge(draft, macos, join(dir, 'notes.md'));
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /for version 0\.2\.9, not 0\.3\.0/);
    assert.ok(!existsSync(join(macos, 'latest.json')) && !existsSync(join(macos, 'SHA256SUMS.txt')));
  });
});
