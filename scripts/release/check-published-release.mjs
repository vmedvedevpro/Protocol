#!/usr/bin/env node
// Checks a published release the way a user and the updater see it: without a
// token, through the public download URLs. Run by release-published.yml.
//
//   node scripts/release/check-published-release.mjs --tag v0.3.0 --dir <empty dir> [--prerelease true|false] [--skip-latest]
//
// Reads SHA256SUMS.txt for the platforms the release has: always Windows and
// Linux, macOS once its build has joined (#164). Downloads every asset of those
// platforms, checks them against SHA256SUMS.txt, checks latest.json (version,
// exactly those platforms' keys, tag-specific URLs, signatures equal to the
// .sig files and valid for the public key in tauri.conf.json, with the signed
// version), and for a stable release that /releases/latest/download/latest.json
// is this release's feed, so installed apps are offered this version.
// --skip-latest leaves that last check out: the macOS job runs this after it
// joins a release that is already published, which may no longer be Latest.
import { createWriteStream, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DRAFT_PLATFORMS,
  FEED_PLATFORMS,
  PLATFORMS,
  PLATFORM_PAYLOADS,
  REPOSITORY,
  UPDATER_ENDPOINT,
  assetUrl,
  feedKeys,
  parseSha256Sums,
  platformsOf,
  requiredAssets,
  versionFromTag,
} from './release-lib.mjs';
import { verifyUpdaterSignature } from './verify-updater-signature.mjs';
import { checkSums } from './write-sha256sums.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
}

// Paths of the strings in a parsed feed, keys included, that hold a lone UTF-16
// surrogate. JSON.parse accepts an escaped one (\ud83d); the updater's
// serde_json rejects the whole feed, so no installed app could update.
export function loneSurrogatePaths(value, path = 'latest.json') {
  if (typeof value === 'string') return value.isWellFormed() ? [] : [path];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(key.isWellFormed() ? [] : [`${path} (a key)`]),
    ...loneSurrogatePaths(child, `${path}.${key}`),
  ]);
}

// The platforms a published release's SHA256SUMS.txt covers, as
// { platforms, problems }: Windows and Linux are required, macOS may still be
// missing, and a platform is listed completely or not at all.
export function publishedPlatforms(sumsText, version) {
  const { platforms, problems } = platformsOf(parseSha256Sums(sumsText).map(({ name }) => name), version);
  for (const platform of DRAFT_PLATFORMS) {
    if (!platforms.includes(platform)) problems.push(`SHA256SUMS.txt lists no ${platform} assets`);
  }
  return { platforms, problems };
}

// Problems with a downloaded feed of a release with `platforms`, given the
// .sig contents by asset name.
export function feedProblems(feed, version, signatures, { platforms: releasePlatforms = PLATFORMS, repository = REPOSITORY } = {}) {
  const problems = loneSurrogatePaths(feed).map((path) => `${path}: lone UTF-16 surrogate, the updater cannot parse the feed`);
  if (feed.version !== version) problems.push(`latest.json says version ${feed.version}`);
  const keys = feedKeys(releasePlatforms);
  const platforms = Object.keys(feed.platforms ?? {}).sort();
  if (platforms.join() !== [...keys].sort().join()) problems.push(`latest.json platforms: ${platforms.join(', ')}`);
  for (const platform of keys) {
    const asset = FEED_PLATFORMS[platform];
    const entry = feed.platforms?.[platform];
    if (!entry) continue;
    if (entry.url !== assetUrl(version, asset, repository)) problems.push(`${platform}: url ${entry.url}`);
    if (entry.signature !== signatures[asset]?.trim()) problems.push(`${platform}: signature differs from ${asset}.sig`);
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const tag = option('tag');
  const dir = option('dir');
  const version = versionFromTag(tag ?? '');
  if (!version || !dir) {
    console.error('usage: check-published-release.mjs --tag vX.Y.Z --dir <dir> [--prerelease true|false] [--skip-latest]');
    process.exit(2);
  }
  await download(assetUrl(version, 'SHA256SUMS.txt'), join(dir, 'SHA256SUMS.txt'));
  const { platforms, problems } = publishedPlatforms(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'), version);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`The release has ${platforms.join(', ')}.`);
  const assets = requiredAssets(version, platforms);
  for (const name of assets.filter((name) => name !== 'SHA256SUMS.txt')) {
    await download(assetUrl(version, name), join(dir, name));
    console.log(`downloaded ${name}`);
  }
  problems.push(...await checkSums(dir));

  const payloads = platforms.map((platform) => PLATFORM_PAYLOADS[platform]);
  const feed = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  const signatures = Object.fromEntries(payloads.map((name) => [name, readFileSync(join(dir, `${name}.sig`), 'utf8')]));
  problems.push(...feedProblems(feed, version, signatures, { platforms }));
  const pubkey = JSON.parse(readFileSync(join(root, 'frontend/src-tauri/tauri.conf.json'), 'utf8')).plugins?.updater?.pubkey;
  if (!pubkey) problems.push('tauri.conf.json at this tag has no updater public key');
  for (const name of pubkey ? payloads : []) {
    try {
      await verifyUpdaterSignature({ publicKeyBase64: pubkey, signatureBase64: signatures[name], path: join(dir, name), expectedVersion: version });
    } catch (error) {
      problems.push(`${name}: ${error.message}`);
    }
  }

  if (option('prerelease') !== 'true' && !args.includes('--skip-latest')) {
    // /releases/latest can lag the publish by a little.
    let served;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(UPDATER_ENDPOINT, { redirect: 'follow' });
      served = response.ok ? (await response.json()).version : `HTTP ${response.status}`;
      if (served === version) break;
      await new Promise((done) => setTimeout(done, 30_000));
    }
    if (served !== version) problems.push(`${UPDATER_ENDPOINT} serves ${served}: mark this release as Latest`);
  }

  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(`Published ${tag} verified: ${assets.length} assets (${platforms.join(', ')}), checksums, feed and signatures.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
