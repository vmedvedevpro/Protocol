import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { parseArgs } from '../bump-version.mjs';
import { CHANGELOG, VERSION_FILES, readVersionFiles } from '../release-lib.mjs';
import { repoRoot, withTempDir } from './helpers.mjs';

test('the version comes with or without --date, in either order', () => {
  assert.deepEqual(parseArgs(['0.3.0'], '2026-10-30'), { version: '0.3.0', date: '2026-10-30' });
  assert.deepEqual(parseArgs(['0.3.0', '--date', '2026-11-02'], '2026-10-30'), { version: '0.3.0', date: '2026-11-02' });
  assert.deepEqual(parseArgs(['--date', '2026-11-02', '0.3.0-rc.1'], '2026-10-30'), { version: '0.3.0-rc.1', date: '2026-11-02' });
  for (const args of [[], ['v0.3.0'], ['0.3.0', '0.3.1'], ['0.3.0', '--date'], ['0.3.0', '--date', '02.11.2026'], ['0.3.0', '--force']]) {
    assert.equal(parseArgs(args, '2026-10-30'), null, JSON.stringify(args));
  }
});

// The CLI rewrites the files next to its own scripts/release folder, so it runs
// from a copy of the repository's version files and CHANGELOG.
function runOnCopy(dir, args) {
  for (const path of [...Object.values(VERSION_FILES), CHANGELOG, 'scripts/release/bump-version.mjs', 'scripts/release/release-lib.mjs']) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(dir, path));
  }
  return spawnSync(process.execPath, [join(dir, 'scripts/release/bump-version.mjs'), ...args], { encoding: 'utf8' });
}

const versions = (version) => ({ tauriConf: version, cargoToml: version, cargoLock: version, packageJson: version });

test('the CLI bumps every file with today\'s date when --date is left out', async () => {
  await withTempDir(async (dir) => {
    const today = new Date().toISOString().slice(0, 10);
    const run = runOnCopy(dir, ['9.8.7']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readVersionFiles(dir), versions('9.8.7'));
    const changelog = readFileSync(join(dir, CHANGELOG), 'utf8');
    // The run may cross midnight UTC.
    assert.ok([today, new Date().toISOString().slice(0, 10)].some((date) => changelog.includes(`## Protocol 9.8.7 — ${date}`)));
  });
});

test('the CLI takes --date and rejects a bad command line', async () => {
  await withTempDir(async (dir) => {
    const run = runOnCopy(dir, ['9.8.7-rc.1', '--date', '2026-11-02']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(readVersionFiles(dir), versions('9.8.7-rc.1'));
    assert.ok(readFileSync(join(dir, CHANGELOG), 'utf8').includes('## Protocol 9.8.7-rc.1 — 2026-11-02'));
  });
  await withTempDir(async (dir) => {
    const before = readVersionFiles(repoRoot);
    const run = runOnCopy(dir, ['--date', '2026-11-02']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^usage: bump-version\.mjs/);
    assert.deepEqual(readVersionFiles(dir), before);
  });
});
