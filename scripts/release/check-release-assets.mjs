#!/usr/bin/env node
// Asserts that a release's files are complete before and after the upload.
//
//   node scripts/release/check-release-assets.mjs --version 0.3.0 --dir dist [--platforms windows,linux] [--stage legs|signed]
//   node scripts/release/check-release-assets.mjs --version 0.3.0 --dir dist [--platforms windows,linux] --release <file>
//   node scripts/release/check-release-assets.mjs --version 0.3.0 --dir joined --stage joined --platforms macos --release <file>
//
// --platforms:    the platforms dist covers (default all three).
// --stage legs:   dist holds exactly the platform assets the build legs make.
// --stage signed: (default) also their .sig files, latest.json and SHA256SUMS.txt.
// --stage joined: dist holds what a platform joining a drafted release uploads
//                 (merge-macos.mjs): its assets, the merged latest.json and
//                 SHA256SUMS.txt.
// --release:      JSON of GET /repos/{repo}/releases/{id}. Signed: the release
//                 is still a draft and its assets equal the local files.
//                 Joined: the release, draft or published, has every asset of
//                 all three platforms, and the uploaded ones equal the local
//                 files. Files are compared by name, size and SHA-256 digest.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLATFORMS, parsePlatforms, platformAssets, releaseAssets, requiredAssets, sha256File } from './release-lib.mjs';

export function expectedAssets(version, stage, platforms = PLATFORMS) {
  if (stage === 'legs') return platforms.flatMap((platform) => releaseAssets(version)[platform]).sort();
  if (stage === 'joined') return [...platforms.flatMap((platform) => platformAssets(version, platform)), 'latest.json', 'SHA256SUMS.txt'].sort();
  if (stage === 'signed') return requiredAssets(version, platforms);
  throw new Error(`unknown stage ${stage}`);
}

// Problems with a set of names compared to the expected set.
export function setProblems(actual, expected, where) {
  const problems = [];
  for (const name of expected) if (!actual.includes(name)) problems.push(`${where}: ${name} is missing`);
  for (const name of actual) if (!expected.includes(name)) problems.push(`${where}: unexpected ${name}`);
  return problems;
}

// Problems with an uploaded release; `local` maps name to { size, sha256 }.
// The release must hold exactly `expected` (by default the local files) and,
// unless `draft` is false, still be a draft. An asset without a digest (GitHub
// computes it after the upload) is checked by size only.
export function releaseProblems(release, local, { draft = true, expected = Object.keys(local).sort() } = {}) {
  const problems = [];
  if (draft && !release.draft) problems.push('the release is no longer a draft');
  const assets = release.assets ?? [];
  problems.push(...setProblems(assets.map((asset) => asset.name).sort(), expected, 'release'));
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
    console.error('usage: check-release-assets.mjs --version <v> --dir <dir> [--platforms <list>] [--stage legs|signed|joined] [--release <file>]');
    process.exit(2);
  }
  const stage = option('stage') ?? 'signed';
  const platforms = option('platforms') ? parsePlatforms(option('platforms')) : PLATFORMS;
  const names = readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile()).sort();
  const problems = setProblems(names, expectedAssets(version, stage, platforms), dir);
  if (option('release')) {
    const local = {};
    for (const name of names) local[name] = { size: statSync(join(dir, name)).size, sha256: await sha256File(join(dir, name)) };
    const release = JSON.parse(readFileSync(option('release'), 'utf8'));
    // A joined platform completes the release, whatever it was drafted with.
    const joined = stage === 'joined' ? { draft: false, expected: requiredAssets(version) } : {};
    problems.push(...releaseProblems(release, local, joined));
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
