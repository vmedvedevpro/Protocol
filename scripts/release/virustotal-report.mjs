#!/usr/bin/env node
// Scans a published release with VirusTotal and writes the detection counts
// and report links to the job summary. Run by virustotal.yml.
//
//   node scripts/release/virustotal-report.mjs --tag v0.3.0 --dir <empty dir> [--all]
//
// The Windows setup by default; --all adds the macOS and Linux packages and
// the macOS updater bundle. Without VT_API_KEY it writes a notice and exits 0,
// so the workflow stays green until the owner adds the secret.
//
// Hashes come from the release's SHA256SUMS.txt. A file VirusTotal already
// knows is not uploaded again; any other is downloaded anonymously, checked
// against the list, uploaded and waited for. The public API allows 4 requests
// a minute, so requests are spaced 15 s apart. Detections do not fail the run:
// unsigned installers often get a few heuristic ones, and the counts are for
// the owner to read.
import { appendFileSync, createWriteStream, openAsBlob, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { assetUrl, parseSha256Sums, releaseAssets, sha256File, versionFromTag } from './release-lib.mjs';

const API = 'https://www.virustotal.com/api/v3';
const REQUEST_SPACING_MS = 15_000;
// Files above this size need an upload URL from the API first.
const DIRECT_UPLOAD_LIMIT = 32 * 1024 * 1024;
const ANALYSIS_TIMEOUT_MS = 30 * 60_000;

export function reportUrl(hash) {
  return `https://www.virustotal.com/gui/file/${hash}`;
}

export function scannedAssets(version, all = false) {
  const assets = releaseAssets(version);
  return all ? Object.values(assets).flat() : assets.windows;
}

// VirusTotal's "N/M security vendors flagged this file": malicious and
// suspicious verdicts out of the engines that gave a verdict.
export function detections(stats) {
  const flagged = (stats.malicious ?? 0) + (stats.suspicious ?? 0);
  const engines = flagged + (stats.undetected ?? 0) + (stats.harmless ?? 0);
  return { flagged, engines };
}

export function summaryMarkdown(tag, rows) {
  const lines = [
    `### VirusTotal: ${tag}`,
    '',
    '| File | Flagged | Report |',
    '| --- | --- | --- |',
    ...rows.map(({ name, hash, stats }) => {
      const { flagged, engines } = detections(stats);
      return `| \`${name}\` | ${flagged}/${engines} | [${hash.slice(0, 12)}…](${reportUrl(hash)}) |`;
    }),
    '',
  ];
  return lines.join('\n');
}

export function createClient({ apiKey, fetchImpl = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), spacing = REQUEST_SPACING_MS }) {
  let last = -Infinity;
  async function request(url, options = {}) {
    const wait = last + spacing - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const response = await fetchImpl(url, { ...options, headers: { 'x-apikey': apiKey, ...options.headers } });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${url}: HTTP ${response.status} ${await response.text()}`);
    return response.json();
  }

  // The last analysis of a known file, or null when VirusTotal has none yet.
  async function fileStats(hash) {
    const body = await request(`${API}/files/${hash}`);
    const stats = body?.data?.attributes?.last_analysis_stats;
    return stats && Object.keys(body.data.attributes.last_analysis_results ?? {}).length > 0 ? stats : null;
  }

  async function upload(path, name) {
    const url = statSync(path).size > DIRECT_UPLOAD_LIMIT ? (await request(`${API}/files/upload_url`)).data : `${API}/files`;
    const form = new FormData();
    form.append('file', await openAsBlob(path), name);
    return (await request(url, { method: 'POST', body: form })).data.id;
  }

  // The upload's own verdicts; the file object can lag behind them.
  async function waitForAnalysis(id, timeout = ANALYSIS_TIMEOUT_MS) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const attributes = (await request(`${API}/analyses/${id}`))?.data?.attributes;
      if (attributes?.status === 'completed') return attributes.stats;
      await sleep(60_000);
    }
    throw new Error(`analysis ${id} did not complete in ${timeout / 60_000} minutes`);
  }

  return { fileStats, upload, waitForAnalysis };
}

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path));
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
    console.error('usage: virustotal-report.mjs --tag vX.Y.Z --dir <dir> [--all]');
    process.exit(2);
  }
  if (!process.env.VT_API_KEY) {
    const skipped = `VirusTotal scan of ${tag} skipped: the VT_API_KEY secret is not set (see WORKFLOWS_OVERVIEW.md).`;
    console.log(`::notice::${skipped}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${skipped}\n`);
    return;
  }

  const sumsResponse = await fetch(assetUrl(version, 'SHA256SUMS.txt'), { redirect: 'follow' });
  if (!sumsResponse.ok) throw new Error(`SHA256SUMS.txt: HTTP ${sumsResponse.status}`);
  const hashes = new Map(parseSha256Sums(await sumsResponse.text()).map(({ name, hash }) => [name, hash]));
  const client = createClient({ apiKey: process.env.VT_API_KEY });
  const rows = [];
  for (const name of scannedAssets(version, args.includes('--all'))) {
    const hash = hashes.get(name);
    if (!hash) throw new Error(`${name} is not in SHA256SUMS.txt`);
    let stats = await client.fileStats(hash);
    if (!stats) {
      const path = join(dir, name);
      await download(assetUrl(version, name), path);
      if ((await sha256File(path)) !== hash) throw new Error(`${name}: checksum differs from SHA256SUMS.txt`);
      console.log(`uploading ${name}`);
      stats = await client.waitForAnalysis(await client.upload(path, name));
    }
    const { flagged, engines } = detections(stats);
    console.log(`${name}: ${flagged}/${engines} ${reportUrl(hash)}`);
    rows.push({ name, hash, stats });
  }

  const summary = summaryMarkdown(tag, rows);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
