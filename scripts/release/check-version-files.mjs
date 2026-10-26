#!/usr/bin/env node
// Fails unless tauri.conf.json, Cargo.toml, Cargo.lock and package.json all
// carry <version>. The build legs run it first, so a leg called with the
// wrong version stops before its long compile.
//
//   node scripts/release/check-version-files.mjs <version>
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVersionFiles, versionFileErrors } from './release-lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('usage: check-version-files.mjs <version>');
    process.exit(2);
  }
  const errors = versionFileErrors(readVersionFiles(root), version);
  for (const error of errors) console.error(error);
  if (errors.length > 0) process.exit(1);
  console.log(`All version files say ${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
