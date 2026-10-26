#!/usr/bin/env node
// Makes the edits of a release PR: the version in tauri.conf.json, Cargo.toml,
// Cargo.lock and package.json, and the CHANGELOG's unreleased section turned
// into `## Protocol <version> — <date>` under a new, empty unreleased heading.
//
//   node scripts/release/bump-version.mjs <version> [--date YYYY-MM-DD]
//
// The date defaults to today (UTC). Run `cargo metadata --locked
// --format-version 1` afterwards to confirm Cargo.lock still matches.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CHANGELOG, VERSION_FILES, bumpVersionFiles, cutChangelog, parseVersion } from './release-lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

// { version, date } from `<version> [--date YYYY-MM-DD]` (in either order),
// or null for anything else. `today` is the default date.
export function parseArgs(args, today) {
  let version = null;
  let date = today;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--date') {
      date = args[index + 1];
      index += 1;
    } else if (version === null && !args[index].startsWith('--')) {
      version = args[index];
    } else {
      return null;
    }
  }
  if (!parseVersion(version ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  return { version, date };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2), new Date().toISOString().slice(0, 10));
  if (!parsed) {
    console.error('usage: bump-version.mjs <X.Y.Z|X.Y.Z-rc.N> [--date YYYY-MM-DD]');
    process.exit(2);
  }
  const { version, date } = parsed;
  const texts = Object.fromEntries(
    Object.entries(VERSION_FILES).map(([key, path]) => [key, readFileSync(join(root, path), 'utf8')]),
  );
  const changelog = cutChangelog(readFileSync(join(root, CHANGELOG), 'utf8'), version, date);
  for (const [key, text] of Object.entries(bumpVersionFiles(texts, version))) {
    writeFileSync(join(root, VERSION_FILES[key]), text);
  }
  writeFileSync(join(root, CHANGELOG), changelog);
  console.log(`Version ${version} written to ${Object.values(VERSION_FILES).join(', ')} and ${CHANGELOG} (${date}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
