#!/usr/bin/env node
// Helpers for the updater end-to-end runs (docs/AUTO_UPDATE.md). Never used
// for releases: the release pipeline writes the real latest.json.
//
//   node scripts/updater-e2e.mjs config --identity e2e|qa --version 9.0.0 \
//     --pubkey-file <key.pub> --port 8765 --out <overlay.json>
//   node scripts/updater-e2e.mjs feed --dir <feed dir> --version 9.0.1 \
//     --base-url http://127.0.0.1:8765/ --asset windows-x86_64-nsis=<file> ...
//   node scripts/updater-e2e.mjs serve --dir <feed dir> --port 8765
//
// `config` writes a `tauri build --config` overlay with a separate identity, so
// the test copy never shares data, the install folder or the executable name
// with an installed Protocol. `feed` reads <file>.sig next to each asset.
// `serve` binds to 127.0.0.1 only and logs one line per request, so a run can
// prove that no request was made.
import { createReadStream, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve, sep } from 'node:path';

const IDENTITIES = {
  e2e: { productName: 'Protocol E2E', identifier: 'io.github.vmedvedevpro.protocol.e2e', mainBinaryName: 'protocol-e2e' },
  qa: { productName: 'Protocol QA', identifier: 'io.github.vmedvedevpro.protocol.qa', mainBinaryName: 'protocol-qa' },
};

function options(argv) {
  const parsed = { asset: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!key || value === undefined) throw new Error(`Missing value for ${argv[i]}`);
    if (key === 'asset') parsed.asset.push(value);
    else parsed[key] = value;
  }
  return parsed;
}

function config({ identity, version, 'pubkey-file': pubkeyFile, port, out }) {
  const names = IDENTITIES[identity];
  if (!names || !version || !pubkeyFile || !out) {
    throw new Error('config needs --identity e2e|qa, --version, --pubkey-file and --out');
  }
  const overlay = {
    ...names,
    version,
    bundle: { createUpdaterArtifacts: true },
    plugins: {
      updater: {
        pubkey: readFileSync(pubkeyFile, 'utf8').trim(),
        endpoints: [`http://127.0.0.1:${port ?? 8765}/latest.json`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
  writeFileSync(out, `${JSON.stringify(overlay, null, 2)}\n`);
  console.log(`${out}: ${names.productName} ${version}`);
}

function feed({ dir, version, 'base-url': baseUrl, asset, notes }) {
  if (!dir || !version || !baseUrl || asset.length === 0) {
    throw new Error('feed needs --dir, --version, --base-url and at least one --asset key=file');
  }
  const platforms = {};
  for (const entry of asset) {
    const [key, file] = entry.split(/=(.*)/s);
    const path = resolve(dir, file);
    const signature = readFileSync(`${path}.sig`, 'utf8').trim();
    platforms[key] = { signature, url: new URL(encodeURIComponent(basename(path)), baseUrl).href };
  }
  const latest = {
    version,
    notes: notes ?? `## Protocol ${version}\n\nEnd-to-end test release.`,
    pub_date: new Date().toISOString(),
    platforms,
  };
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`latest.json: ${version} for ${Object.keys(platforms).join(', ')}`);
}

function serve({ dir, port }) {
  const root = resolve(dir);
  const server = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    const path = resolve(root, name);
    console.log(`${new Date().toISOString()} ${request.method} /${name} ${request.headers['user-agent'] ?? ''}`);
    let size = -1;
    try {
      if (path.startsWith(root + sep) && statSync(path).isFile()) size = statSync(path).size;
    } catch {
      size = -1;
    }
    if (size < 0) {
      response.writeHead(404).end();
      return;
    }
    const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
    createReadStream(path).pipe(response);
  });
  server.listen(Number(port ?? 8765), '127.0.0.1', () => console.log(`serving ${root} on 127.0.0.1:${port ?? 8765}`));
}

const commands = { config, feed, serve };
const [command, ...rest] = process.argv.slice(2);
if (commands[command]) commands[command](options(rest));
else {
  console.error('usage: updater-e2e.mjs config|feed|serve ...');
  process.exitCode = 2;
}
