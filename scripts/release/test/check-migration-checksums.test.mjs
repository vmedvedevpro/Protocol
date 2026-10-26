import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  MIGRATIONS_DIR,
  TABLE_PATH,
  compareWithTable,
  computeFromGit,
  expectedChecksums,
  migrationVersion,
  sha384,
  windowsForm,
} from '../check-migration-checksums.mjs';
import { repoRoot, withTempDir } from './helpers.mjs';

const table = (migrations) => ({ platformSpecificThrough: '20251229000000', migrations });

test('windows form converts every LF and rejects blobs that already contain CR', () => {
  assert.equal(windowsForm(Buffer.from('a\nb\n')).toString(), 'a\r\nb\r\n');
  assert.throws(() => windowsForm(Buffer.from('a\r\nb\n')), /ambiguous/);
});

test('eol=lf files hash the same on both platforms', () => {
  const blob = Buffer.from('CREATE TABLE t (id INTEGER);\n');
  const pinned = expectedChecksums(blob, true);
  assert.equal(pinned.windows, pinned.unix);
  const historical = expectedChecksums(blob, false);
  assert.equal(historical.unix, sha384(blob));
  assert.equal(historical.windows, sha384(Buffer.from('CREATE TABLE t (id INTEGER);\r\n')));
});

test('migration versions come from the sqlx file name', () => {
  assert.equal(migrationVersion('20250916100000_initial_schema.sql'), '20250916100000');
  assert.equal(migrationVersion('README.md'), null);
});

test('a changed released migration, a missing entry and a deleted file are errors', () => {
  const released = table({
    20250916100000: { file: '20250916100000_a.sql', unix: 'u1', windows: 'w1' },
    20260811000000: { file: '20260811000000_b.sql', unix: 'u2', windows: 'u2' },
  });
  assert.deepEqual(compareWithTable(released, {
    20250916100000: { file: '20250916100000_a.sql', unix: 'u1', windows: 'w1', eolLf: false },
    20260811000000: { file: '20260811000000_b.sql', unix: 'u2', windows: 'u2', eolLf: true },
  }), []);

  const changed = compareWithTable(released, {
    20250916100000: { file: '20250916100000_a.sql', unix: 'u1', windows: 'other', eolLf: false },
    20260811000000: { file: '20260811000000_b.sql', unix: 'u2', windows: 'u2', eolLf: true },
  });
  assert.equal(changed.length, 1);
  assert.match(changed[0], /windows checksum other differs/);

  const missing = compareWithTable(released, {
    20250916100000: { file: '20250916100000_a.sql', unix: 'u1', windows: 'w1', eolLf: false },
    20260811000000: { file: '20260811000000_b.sql', unix: 'u2', windows: 'u2', eolLf: true },
    20261001000000: { file: '20261001000000_c.sql', unix: 'u3', windows: 'u3', eolLf: true },
  });
  assert.match(missing.join('\n'), /no entry/);

  const deleted = compareWithTable(released, {
    20250916100000: { file: '20250916100000_a.sql', unix: 'u1', windows: 'w1', eolLf: false },
  });
  assert.match(deleted.join('\n'), /must never be deleted/);
});

test('new migrations must be pinned to LF', () => {
  const released = table({
    20261001000000: { file: '20261001000000_c.sql', unix: 'u3', windows: 'w3' },
  });
  const errors = compareWithTable(released, {
    20261001000000: { file: '20261001000000_c.sql', unix: 'u3', windows: 'w3', eolLf: false },
  });
  assert.match(errors.join('\n'), /text eol=lf/);
  assert.match(errors.join('\n'), /one checksum on every platform/);
});

test('a working tree is compared with its own platform column only', () => {
  const released = table({
    20250916100000: { file: '20250916100000_a.sql', unix: 'u1', windows: 'w1' },
  });
  const lfTree = { 20250916100000: { file: '20250916100000_a.sql', eolLf: null, unix: 'u1' } };
  assert.deepEqual(compareWithTable(released, lfTree, ['unix']), []);
  const crlfAsUnix = { 20250916100000: { file: '20250916100000_a.sql', eolLf: null, unix: 'w1' } };
  assert.equal(compareWithTable(released, crlfAsUnix, ['unix']).length, 1);
});

test('the committed table matches the migrations at HEAD', () => {
  const committed = JSON.parse(readFileSync(new URL(`../../../${TABLE_PATH}`, import.meta.url), 'utf8'));
  assert.deepEqual(compareWithTable(committed, computeFromGit(repoRoot)), []);
});

test('--add-new records the staged blob and refuses a migration that is not staged as is', async () => {
  await withTempDir(async (dir) => {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    const migration = join(dir, MIGRATIONS_DIR, '20261001000000_c.sql');
    const sql = 'CREATE TABLE t (id INTEGER);\n';
    git('init', '-q');
    mkdirSync(join(dir, MIGRATIONS_DIR), { recursive: true });
    writeFileSync(join(dir, '.gitattributes'), `${MIGRATIONS_DIR}/20261001000000_c.sql text eol=lf\n`);
    writeFileSync(join(dir, TABLE_PATH), `${JSON.stringify(table({}), null, 2)}\n`);
    writeFileSync(migration, sql);
    const addNew = () => spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts/release/check-migration-checksums.mjs'), '--add-new', '--repo', dir],
      { encoding: 'utf8' },
    );

    let run = addNew();
    assert.equal(run.status, 1);
    assert.equal(run.stderr, `error: 20261001000000_c.sql is not staged: commit or stage the migration first (git add ${MIGRATIONS_DIR})\n`);

    git('add', '.');
    writeFileSync(migration, `${sql}-- edited\n`);
    run = addNew();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /^error: 20261001000000_c\.sql has unstaged changes: commit or stage/);

    writeFileSync(migration, sql);
    run = addNew();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^Added 1 migration checksum entry/);
    const written = JSON.parse(readFileSync(join(dir, TABLE_PATH), 'utf8'));
    assert.deepEqual(written.migrations, {
      20261001000000: { file: '20261001000000_c.sql', unix: sha384(Buffer.from(sql)), windows: sha384(Buffer.from(sql)) },
    });
  });
});
