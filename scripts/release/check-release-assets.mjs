#!/usr/bin/env node
// Asserts that a release's files are complete before and after the upload.
//
//   node scripts/release/check-release-assets.mjs --version 0.3.0 --dir dist [--stage legs|signed]
//   node scripts/release/check-release-assets.mjs --version 0.3.0 --dir dist --release <file>
//
// --stage legs:   dist holds exactly the platform assets the build legs make.
// --stage signed: (default) also every .sig, latest.json and SHA256SUMS.txt.
// --release:      the draft (JSON of GET /repos/{repo}/releases/{id}) is still
//                 a draft and its assets equal the local files by name, size
//                 and SHA-256 digest.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseAssets, requiredAssets, sha256File } from './release-lib.mjs';

export function expectedAssets(version, stage) {
  return stage === 'legs' ? Object.values(releaseAssets(version)).flat().sort() : requiredAssets(version);
}

// Problems with a set of names compared to the expected set.
export function setProblems(actual, expected, where) {
  const problems = [];
  for (const name of expected) if (!actual.includes(name)) problems.push(`${where}: ${name} is missing`);
  for (const name of actual) if (!expected.includes(name)) problems.push(`${where}: unexpected ${name}`);
  return problems;
}

// Problems with an uploaded draft; `local` maps name to { size, sha256 }. An
// asset without a digest (GitHub computes it after the upload) is checked by
// size only.
export function releaseProblems(release, local) {
  const problems = [];
  if (!release.draft) problems.push('the release is no longer a draft');
  const assets = release.assets ?? [];
  problems.push(...setProblems(assets.map((asset) => asset.name).sort(), Object.keys(local).sort(), 'release'));
  for (const asset of assets) {
    const file = local[asset.name];
    if (!file) continue;
    if (asset.state !== 'uploaded') problems.push(`${asset.name}: state ${asset.state}`);
    if (asset.size !== file.size) problems.push(`${asset.name}: ${asset.size} bytes uploaded, ${file.size} local`);
    if (asset.digest && asset.digest !== `sha256:${file.sha256}`) problems.push(`${asset.name}: digest ${asset.digest} differs`);
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const version = option('version');
  const dir = option('dir');
  if (!version || !dir) {
    console.error('usage: check-release-assets.mjs --version <v> --dir <dir> [--stage legs|signed] [--release <file>]');
    process.exit(2);
  }
  const names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).sort();
  const problems = setProblems(names, expectedAssets(version, option('stage') ?? 'signed'), dir);
  if (option('release')) {
    const local = {};
    for (const name of names) local[name] = { size: statSync(join(dir, name)).size, sha256: await sha256File(join(dir, name)) };
    const release = JSON.parse(readFileSync(option('release'), 'utf8'));
    problems.push(...releaseProblems(release, local));
    for (const asset of release.assets ?? []) {
      if (!asset.digest) console.log(`warning: GitHub reports no digest for ${asset.name} yet; checked by size`);
    }
  }
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`${names.length} release files checked: ${names.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
