import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeSums } from '../write-sha256sums.mjs';
import { repoRoot, withTempDir } from './helpers.mjs';

// On Windows, `bash` may resolve to WSL's; CI runs this on Linux.
const skip = process.platform === 'win32' && 'needs a POSIX bash';

// Runs the script up to the point where it moves the legs' files; the notes,
// key and output paths are never reached.
function assemble(legs, dist) {
  return spawnSync('bash', [join(repoRoot, 'scripts/release/assemble-release.sh'), legs, dist, 'notes.md', 'key.pub', 'out.md'], {
    encoding: 'utf8',
    env: { ...process.env, VERSION: '0.3.0' },
  });
}

async function leg(legs, name, files) {
  const dir = join(legs, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  await writeSums(dir);
}

test('assembly refuses a dist folder that is not empty', { skip }, async () => {
  await withTempDir(async (dir) => {
    const legs = join(dir, 'legs');
    await leg(legs, 'leg-windows', { 'protocol-windows-x64-setup.exe': 'new' });
    const dist = join(dir, 'dist');
    mkdirSync(dist);
    writeFileSync(join(dist, 'protocol-windows-x64-setup.exe'), 'left from an earlier run');
    const run = assemble(legs, dist);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /dist is not empty/);
    assert.ok(existsSync(join(legs, 'leg-windows', 'protocol-windows-x64-setup.exe')), 'nothing was moved');
  });
});

test('assembly refuses a file that two legs carry', { skip }, async () => {
  await withTempDir(async (dir) => {
    const legs = join(dir, 'legs');
    await leg(legs, 'leg-a', { 'protocol-windows-x64-setup.exe': 'a' });
    await leg(legs, 'leg-b', { 'protocol-windows-x64-setup.exe': 'b' });
    const run = assemble(legs, join(dir, 'dist'));
    assert.equal(run.status, 1);
    assert.match(run.stdout, /protocol-windows-x64-setup\.exe comes from more than one leg/);
  });
});

test('assembly takes only the Windows and Linux legs; macOS joins the release later', { skip }, async () => {
  await withTempDir(async (dir) => {
    const legs = join(dir, 'legs');
    await leg(legs, 'leg-windows', { 'protocol-windows-x64-setup.exe': 'w' });
    await leg(legs, 'leg-linux', { 'protocol-linux-x86_64.AppImage': 'a', 'protocol_0.3.0_amd64.deb': 'd' });
    await leg(legs, 'leg-macos', { 'protocol-macos-arm64.dmg': 'm', 'protocol-macos-arm64.app.tar.gz': 't' });
    const run = assemble(legs, join(dir, 'dist'));
    assert.equal(run.status, 1);
    assert.match(run.stderr, /unexpected protocol-macos-arm64\.app\.tar\.gz/);
  });
});
