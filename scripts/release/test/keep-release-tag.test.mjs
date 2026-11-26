import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot, withTempDir } from './helpers.mjs';

// A gh that serves one release from state.json: `gh api <endpoint>` prints
// it, `gh api -X PATCH <endpoint> -f tag_name=<tag>` sets its tag unless
// `ignorePatch` is set. Every call is recorded in state.calls.
const FAKE_GH = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args.join(' '));
if (args[0] !== 'api' || !args.includes('repos/owner/repo/releases/42')) process.exit(3);
if (args.includes('PATCH')) {
  const field = args[args.indexOf('-f') + 1];
  if (!state.ignorePatch) state.release.tag_name = field.slice('tag_name='.length);
} else {
  process.stdout.write(JSON.stringify(state.release));
}
writeFileSync(file, JSON.stringify(state));
`;

function keepTag(dir, release, { ignorePatch = false } = {}) {
  const gh = join(dir, 'gh');
  writeFileSync(gh, FAKE_GH);
  chmodSync(gh, 0o755);
  const stateFile = join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ release, ignorePatch, calls: [] }));
  const out = join(dir, 'release.json');
  const result = spawnSync('bash', [join(repoRoot, 'scripts/release/keep-release-tag.sh'), '42', 'v1.0.0', out], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH_STATE: stateFile, GITHUB_REPOSITORY: 'owner/repo' },
  });
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  return { ...result, calls: state.calls, written: JSON.parse(readFileSync(out, 'utf8')) };
}

const placeholder = 'untagged-38ca44aeba8f67a5b7a9';

test('a release that has its tag is only read', async () => {
  await withTempDir(async (dir) => {
    const run = keepTag(dir, { id: 42, tag_name: 'v1.0.0', draft: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(run.calls, ['api repos/owner/repo/releases/42']);
    assert.equal(run.written.tag_name, 'v1.0.0');
  });
});

test('a draft with a placeholder tag gets its tag back and is read again', async () => {
  await withTempDir(async (dir) => {
    const run = keepTag(dir, { id: 42, tag_name: placeholder, draft: true });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(run.calls, [
      'api repos/owner/repo/releases/42',
      'api -X PATCH repos/owner/repo/releases/42 -f tag_name=v1.0.0',
      'api repos/owner/repo/releases/42',
    ]);
    assert.match(run.stdout, /::warning::Draft 42 has the tag untagged-38ca44aeba8f67a5b7a9 instead of v1\.0\.0/);
    assert.equal(run.written.tag_name, 'v1.0.0');
  });
});

test('a draft that keeps the placeholder after the patch fails the step', async () => {
  await withTempDir(async (dir) => {
    const run = keepTag(dir, { id: 42, tag_name: placeholder, draft: true }, { ignorePatch: true });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error::Draft 42 still has the tag untagged-38ca44aeba8f67a5b7a9 after it was set to v1\.0\.0/);
    assert.equal(run.calls.length, 3);
  });
});

test('a published release with another tag is not retagged', async () => {
  await withTempDir(async (dir) => {
    const run = keepTag(dir, { id: 42, tag_name: placeholder, draft: false });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error::Release 42 is published with the tag untagged-38ca44aeba8f67a5b7a9, not v1\.0\.0/);
    assert.deepEqual(run.calls, ['api repos/owner/repo/releases/42']);
  });
});

test('a release that cannot be read fails the step', async () => {
  await withTempDir(async (dir) => {
    const gh = join(dir, 'gh');
    writeFileSync(gh, '#!/usr/bin/env bash\necho "HTTP 404: Not Found" >&2\nexit 1\n');
    chmodSync(gh, 0o755);
    const run = spawnSync('bash', [join(repoRoot, 'scripts/release/keep-release-tag.sh'), '42', 'v1.0.0', join(dir, 'release.json')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'owner/repo' },
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /HTTP 404/);
  });
});
