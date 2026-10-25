#!/usr/bin/env node
// Writes the updater feed of a release from the signed payloads in a folder.
//
//   node scripts/release/make-latest-json.mjs --version 0.3.0 --notes <file> --dir dist [--pub-date <RFC 3339>] [--repository owner/name]
//
// Reads <dir>/<payload>.sig for each updater payload and writes <dir>/latest.json.
// Run it after the final signatures exist: the feed carries their content.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, UPDATER_PAYLOADS, latestJson } from './release-lib.mjs';

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const version = option('version');
  const dir = option('dir');
  if (!version || !dir || !option('notes')) {
    console.error('usage: make-latest-json.mjs --version <v> --notes <file> --dir <dir> [--pub-date <date>] [--repository <owner/name>]');
    process.exit(2);
  }
  const signatures = Object.fromEntries(
    UPDATER_PAYLOADS.map((name) => [name, readFileSync(join(dir, `${name}.sig`), 'utf8')]),
  );
  const feed = latestJson({
    version,
    notes: readFileSync(option('notes'), 'utf8').trim(),
    pubDate: option('pub-date') ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    signatures,
    repository: option('repository') ?? REPOSITORY,
  });
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(feed, null, 2)}\n`);
  console.log(`Wrote ${join(dir, 'latest.json')} for ${version} (${Object.keys(feed.platforms).join(', ')}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
