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

function main() {
  const args = process.argv.slice(2);
  const dateIndex = args.indexOf('--date');
  const date = dateIndex === -1 ? new Date().toISOString().slice(0, 10) : args[dateIndex + 1];
  const version = args.find((arg, index) => !arg.startsWith('--') && index !== dateIndex + 1);
  if (!version || !parseVersion(version)) {
    console.error('usage: bump-version.mjs <X.Y.Z|X.Y.Z-rc.N> [--date YYYY-MM-DD]');
    process.exit(2);
  }
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
