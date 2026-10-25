#!/usr/bin/env node
// SHA256SUMS.txt in GNU sha256sum format (`<hex>  <name>`, sorted, LF) over
// every other file in a folder, or a check of an existing one.
//
//   node scripts/release/write-sha256sums.mjs <dir>
//   node scripts/release/write-sha256sums.mjs --check <dir>
//
// --check fails when a listed file is missing or differs, or when the folder
// holds a file the list does not name (a leftover would otherwise be uploaded
// unverified).
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatSha256Sums, parseSha256Sums, sha256File } from './release-lib.mjs';

export const SUMS_FILE = 'SHA256SUMS.txt';

function assetFiles(dir) {
  return readdirSync(dir).filter((name) => name !== SUMS_FILE && statSync(join(dir, name)).isFile()).sort();
}

export async function writeSums(dir) {
  const entries = [];
  for (const name of assetFiles(dir)) entries.push({ name, hash: await sha256File(join(dir, name)) });
  writeFileSync(join(dir, SUMS_FILE), formatSha256Sums(entries));
  return entries;
}

// Returns a list of problems; empty when the folder matches its list.
export async function checkSums(dir) {
  const problems = [];
  const listed = parseSha256Sums(readFileSync(join(dir, SUMS_FILE), 'utf8'));
  const present = new Set(assetFiles(dir));
  for (const { name, hash } of listed) {
    if (!present.delete(name)) {
      problems.push(`${name}: listed but missing`);
    } else if ((await sha256File(join(dir, name))) !== hash) {
      problems.push(`${name}: checksum differs`);
    }
  }
  for (const name of present) problems.push(`${name}: not listed in ${SUMS_FILE}`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const dir = check ? args[1] : args[0];
  if (!dir) {
    console.error('usage: write-sha256sums.mjs [--check] <dir>');
    process.exit(2);
  }
  if (check) {
    const problems = await checkSums(dir);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log(`${join(dir, SUMS_FILE)} matches every file in ${dir}.`);
    return;
  }
  const entries = await writeSums(dir);
  console.log(`Wrote ${join(dir, SUMS_FILE)} for ${entries.length} files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
