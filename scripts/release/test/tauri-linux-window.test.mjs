// tauri.linux.conf.json repeats the whole main-window entry, because a
// platform file replaces the `windows` array rather than merging into it
// (docs/LINUX_DESKTOP.md, "Native window frame"). Only `decorations` may
// differ: any other change to tauri.conf.json's window has to reach Linux too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from './helpers.mjs';

const windows = (name) =>
  JSON.parse(readFileSync(join(repoRoot, 'frontend', 'src-tauri', name), 'utf8')).app.windows;

test('the Linux window entry is the base one with the native frame', () => {
  const base = windows('tauri.conf.json');
  const linux = windows('tauri.linux.conf.json');
  assert.equal(base.length, 1);
  assert.equal(linux.length, 1);
  assert.equal(base[0].decorations, false);
  assert.equal(linux[0].decorations, true);
  assert.deepEqual({ ...linux[0], decorations: base[0].decorations }, base[0]);
});
