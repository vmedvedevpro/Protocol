#!/usr/bin/env node
// Guards the SHA-384 checksums sqlx stores for every applied migration.
//
// sqlx embeds frontend/src-tauri/migrations/*.sql at compile time and refuses to
// open a database whose recorded checksum differs from the embedded bytes. The
// ten historical migrations were released from CRLF checkouts on Windows and LF
// checkouts elsewhere, so their checksums differ per platform; every newer
// migration is pinned to LF in .gitattributes and must hash the same everywhere.
// released-migration-checksums.json records both columns.
//
//   --source git                   recompute both columns from the git blobs at
//                                  HEAD (PR checks and release validation)
//   --source worktree --platform windows|unix
//                                  hash the files a build is about to embed
//   --add-new                      append entries for migrations missing from
//                                  the table; never changes an existing entry
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIGRATIONS_DIR = 'frontend/src-tauri/migrations';
export const TABLE_PATH = 'frontend/src-tauri/released-migration-checksums.json';
const MIGRATION_NAME = /^(\d+)_.+\.sql$/;

export function sha384(bytes) {
  return createHash('sha384').update(bytes).digest('hex');
}

// What Git for Windows writes for a text file with core.autocrlf=true. The
// blobs never contain CR, so the conversion is a plain LF -> CRLF replacement.
export function windowsForm(blob) {
  if (blob.includes(0x0d)) {
    throw new Error('blob already contains CR; its Windows checkout form is ambiguous');
  }
  return Buffer.from(blob.toString('latin1').replaceAll('\n', '\r\n'), 'latin1');
}

export function migrationVersion(fileName) {
  const match = MIGRATION_NAME.exec(fileName);
  return match ? match[1] : null;
}

// Expected table columns for one blob. `eolLf` is true when .gitattributes
// pins the file to LF, which makes a Windows checkout identical to the blob.
export function expectedChecksums(blob, eolLf) {
  const unix = sha384(blob);
  return { unix, windows: eolLf ? unix : sha384(windowsForm(blob)) };
}

// Compares computed checksums with the table. `computed` maps version to
// { file, unix, windows, eolLf }; `columns` limits the comparison (a working
// tree has only one platform form). Returns a list of human-readable errors.
export function compareWithTable(table, computed, columns = ['unix', 'windows']) {
  const errors = [];
  const entries = table.migrations ?? {};
  const lastPlatformSpecific = BigInt(table.platformSpecificThrough);
  for (const [version, actual] of Object.entries(computed)) {
    const entry = entries[version];
    if (!entry) {
      errors.push(`${actual.file}: no entry in ${TABLE_PATH}; run this script with --add-new and commit the result`);
      continue;
    }
    if (entry.file !== actual.file) {
      errors.push(`${version}: the table names ${entry.file}, the migration file is ${actual.file}`);
    }
    for (const column of columns) {
      if (entry[column] !== actual[column]) {
        errors.push(`${actual.file}: ${column} checksum ${actual[column]} differs from the released ${entry[column]}; released migrations must never change`);
      }
    }
    if (BigInt(version) > lastPlatformSpecific) {
      if (actual.eolLf === false) {
        errors.push(`${actual.file}: add "${MIGRATIONS_DIR}/${actual.file} text eol=lf" to .gitattributes`);
      }
      if (entry.unix !== entry.windows) {
        errors.push(`${version}: migrations after ${table.platformSpecificThrough} must have one checksum on every platform`);
      }
    }
  }
  for (const version of Object.keys(entries)) {
    if (!computed[version]) {
      errors.push(`${entries[version].file}: listed in ${TABLE_PATH} but missing from ${MIGRATIONS_DIR}; a released migration must never be deleted`);
    }
  }
  return errors;
}

function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: repo, encoding, maxBuffer: 64 * 1024 * 1024 });
}

export function computeFromGit(repo) {
  const files = git(repo, ['ls-files', '-z', '--', MIGRATIONS_DIR]).split('\0').filter(Boolean);
  const computed = {};
  for (const path of files) {
    const file = path.slice(MIGRATIONS_DIR.length + 1);
    const version = migrationVersion(file);
    if (!version) continue;
    const blob = git(repo, ['cat-file', 'blob', `HEAD:${path}`], 'buffer');
    const eol = git(repo, ['check-attr', 'eol', '--', path]).trim().split(': ').pop();
    const eolLf = eol === 'lf';
    computed[version] = { file, eolLf, ...expectedChecksums(blob, eolLf) };
  }
  return computed;
}

export function computeFromWorktree(repo, platform) {
  const computed = {};
  for (const file of readdirSync(join(repo, MIGRATIONS_DIR)).sort()) {
    const version = migrationVersion(file);
    if (!version) continue;
    const checksum = sha384(readFileSync(join(repo, MIGRATIONS_DIR, file)));
    computed[version] = { file, eolLf: null, [platform]: checksum };
  }
  return computed;
}

function parseArgs(argv) {
  const options = { source: 'git', platform: null, addNew: false, repo: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') options.source = argv[++index];
    else if (arg === '--platform') options.platform = argv[++index];
    else if (arg === '--add-new') options.addNew = true;
    else if (arg === '--repo') options.repo = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['git', 'worktree'].includes(options.source)) {
    throw new Error('--source must be git or worktree');
  }
  if (options.source === 'worktree' && !['windows', 'unix'].includes(options.platform)) {
    throw new Error('--source worktree needs --platform windows|unix');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repo = resolve(options.repo ?? fileURLToPath(new URL('../../', import.meta.url)));
  const tablePath = join(repo, TABLE_PATH);
  const table = JSON.parse(readFileSync(tablePath, 'utf8'));

  if (options.addNew) {
    const computed = computeFromGit(repo);
    let added = 0;
    for (const [version, { file, unix, windows }] of Object.entries(computed)) {
      if (table.migrations[version]) continue;
      table.migrations[version] = { file, unix, windows };
      added += 1;
    }
    table.migrations = Object.fromEntries(
      Object.entries(table.migrations).sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1)),
    );
    writeFileSync(tablePath, `${JSON.stringify(table, null, 2)}\n`);
    console.log(`Added ${added} migration checksum entr${added === 1 ? 'y' : 'ies'} to ${TABLE_PATH}.`);
    return;
  }

  const computed = options.source === 'git'
    ? computeFromGit(repo)
    : computeFromWorktree(repo, options.platform);
  const columns = options.source === 'git' ? ['unix', 'windows'] : [options.platform];
  const errors = compareWithTable(table, computed, columns);
  if (errors.length > 0) {
    for (const error of errors) console.error(`error: ${error}`);
    if (options.source === 'worktree') {
      const autocrlf = options.platform === 'windows' ? 'true' : 'false';
      console.error(`hint: a ${options.platform} build must check out with core.autocrlf=${autocrlf}; set it with git config --global before the checkout`);
    }
    process.exit(1);
  }
  const what = options.source === 'git' ? 'git blobs (unix and windows forms)' : `the working tree (${options.platform} form)`;
  console.log(`${Object.keys(computed).length} migrations match the released checksums in ${what}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
