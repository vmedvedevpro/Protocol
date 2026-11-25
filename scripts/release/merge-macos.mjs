#!/usr/bin/env node
// Adds macOS to a release drafted from the Windows and Linux legs (#164):
// merges darwin-aarch64 into its latest.json and the macOS files into its
// SHA256SUMS.txt, and renders the release body again with the macOS download.
//
//   node scripts/release/merge-macos.mjs --version 0.3.0 --release <dir> --dir <dir>
//     [--notes <notes-source> --body <file> --notes-out <file> [--first-release] [--attestations]]
//     [--repository owner/name]
//
// --release holds latest.json and SHA256SUMS.txt as the release has them now.
// --dir holds the signed macOS files (the .dmg, the .app.tar.gz and its .sig);
// the merged latest.json and SHA256SUMS.txt are written next to them, so the
// folder is exactly what the job uploads. --body is the release's current body:
// when it is still the text render-notes.mjs made, the new body goes to
// --notes-out; a body the owner edited by hand is left alone with a warning.
//
// Re-running is safe: darwin entries and macOS lines already in the release
// are replaced, everything else is kept byte for byte, and a feed or list of
// another version, or one with files this pipeline does not make, is refused,
// so a wrong download can never become another release's feed.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DRAFT_PLATFORMS,
  FEED_PLATFORMS,
  LATE_PLATFORM,
  PLATFORM_PAYLOADS,
  REPOSITORY,
  assetUrl,
  feedKeys,
  formatSha256Sums,
  parseSha256Sums,
  platformAssets,
  platformsOf,
  requiredAssets,
  sha256File,
} from './release-lib.mjs';
import { renderNotes } from './render-notes.mjs';

const MACOS_KEYS = feedKeys([LATE_PLATFORM]);

// The release's feed with the darwin keys set to the new macOS payload. The
// feed must be this version's, with every Windows and Linux key pointing at
// this tag, and no key this pipeline does not write.
export function mergeFeed(feed, { version, signature, repository = REPOSITORY }) {
  if (feed.version !== version) throw new Error(`latest.json is for version ${feed.version}, not ${version}`);
  const platforms = feed.platforms ?? {};
  for (const key of Object.keys(platforms)) {
    if (!(key in FEED_PLATFORMS)) throw new Error(`latest.json has an unexpected platform ${key}`);
  }
  for (const key of feedKeys(DRAFT_PLATFORMS)) {
    const url = assetUrl(version, FEED_PLATFORMS[key], repository);
    if (platforms[key]?.url !== url || !platforms[key]?.signature) throw new Error(`latest.json has no ${key} entry for ${url}`);
  }
  if (!signature?.trim()) throw new Error('no signature for the macOS payload');
  const entry = { signature: signature.trim(), url: assetUrl(version, PLATFORM_PAYLOADS[LATE_PLATFORM], repository) };
  const merged = {};
  for (const key of Object.keys(FEED_PLATFORMS)) {
    if (MACOS_KEYS.includes(key)) merged[key] = { ...entry };
    else if (platforms[key]) merged[key] = platforms[key];
  }
  return { ...feed, platforms: merged };
}

// The release's SHA256SUMS.txt with `entries` ({ name, hash }) added or
// replaced. The list must hold only this version's release assets, Windows
// and Linux completely.
export function mergeSums(text, entries, version) {
  const listed = parseSha256Sums(text);
  const names = listed.map(({ name }) => name);
  const allowed = requiredAssets(version).filter((name) => name !== 'SHA256SUMS.txt');
  const unexpected = names.filter((name) => !allowed.includes(name));
  if (unexpected.length > 0) throw new Error(`SHA256SUMS.txt lists unexpected files: ${unexpected.join(', ')}`);
  const { platforms, problems } = platformsOf(names, version);
  const missing = DRAFT_PLATFORMS.filter((platform) => !platforms.includes(platform));
  if (missing.length > 0) problems.push(`SHA256SUMS.txt lists no ${missing.join(' or ')} assets`);
  if (problems.length > 0) throw new Error(problems.join('; '));
  const replaced = new Set(entries.map(({ name }) => name));
  return formatSha256Sums([...listed.filter(({ name }) => !replaced.has(name)), ...entries]);
}

// Line endings and trailing blanks aside, is `body` the text `expected`?
// GitHub may hand back a body with CRLF line endings.
export function sameBody(body, expected) {
  const normalize = (text) => text.replace(/\r\n/g, '\n').trimEnd();
  return normalize(body) === normalize(expected);
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const version = option('version');
  const releaseDir = option('release');
  const dir = option('dir');
  const notesOptions = ['notes', 'body', 'notes-out'].map(option);
  if (!version || !releaseDir || !dir || (notesOptions.some(Boolean) && !notesOptions.every(Boolean))) {
    console.error('usage: merge-macos.mjs --version <v> --release <dir> --dir <dir> [--notes <file> --body <file> --notes-out <file> [--first-release] [--attestations]] [--repository <owner/name>]');
    process.exit(2);
  }
  const repository = option('repository') ?? REPOSITORY;
  const payload = PLATFORM_PAYLOADS[LATE_PLATFORM];

  const feed = mergeFeed(JSON.parse(readFileSync(join(releaseDir, 'latest.json'), 'utf8')), {
    version,
    signature: readFileSync(join(dir, `${payload}.sig`), 'utf8'),
    repository,
  });
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);

  const oldSums = readFileSync(join(releaseDir, 'SHA256SUMS.txt'), 'utf8');
  const entries = [];
  for (const name of [...platformAssets(version, LATE_PLATFORM), 'latest.json']) entries.push({ name, hash: await sha256File(join(dir, name)) });
  const sums = mergeSums(oldSums, entries, version);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), sums);
  console.log(`Merged macOS into latest.json (${Object.keys(feed.platforms).join(', ')}) and SHA256SUMS.txt.`);

  if (option('notes')) {
    const render = (list) => renderNotes({
      version,
      notes: readFileSync(option('notes'), 'utf8'),
      sums: list,
      firstRelease: args.includes('--first-release'),
      attestations: args.includes('--attestations'),
      repository,
    });
    const body = readFileSync(option('body'), 'utf8');
    if (sameBody(body, render(oldSums)) || sameBody(body, render(sums))) {
      writeFileSync(option('notes-out'), render(sums));
      console.log(`Wrote the release body with the macOS download to ${option('notes-out')}.`);
    } else {
      const message = 'The release body was edited by hand, so it was left as it is: add the macOS download and the new SHA256SUMS.txt lines to it yourself.';
      console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning::${message}` : `warning: ${message}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
