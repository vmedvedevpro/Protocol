#!/usr/bin/env node
// Verifies Tauri updater signatures the way tauri-plugin-updater does, so a
// release whose .sig files the installed apps would reject never gets drafted.
//
// Tauri's .sig file and `plugins.updater.pubkey` are base64 of minisign's text
// formats. A minisign signature is Ed25519 over the payload (algorithm "Ed")
// or over its BLAKE2b-512 hash ("ED", what Tauri writes), plus a global
// Ed25519 signature over that signature and the trusted comment. Tauri 2.12's
// `signer sign --app-version` appends `version:<v>` to the trusted comment;
// with `requireSignedVersion` the updater rejects a payload whose signed
// version differs from the feed's.
//
//   node scripts/release/verify-updater-signature.mjs --pubkey <base64|file> [--version <v>] <payload>...
//   (each payload's signature is read from <payload>.sig)
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeBase64Text(value, what) {
  const text = Buffer.from(value.trim(), 'base64').toString('utf8');
  if (!text.startsWith('untrusted comment:')) throw new Error(`${what} is not a base64-encoded minisign file`);
  return text.split(/\r?\n/);
}

// { keyId, key } from the content of plugins.updater.pubkey.
export function parsePublicKey(base64) {
  const lines = decodeBase64Text(base64, 'the public key');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.toString('latin1', 0, 2) !== 'Ed') throw new Error('unsupported minisign public key');
  return {
    keyId: raw.subarray(2, 10).toString('hex'),
    key: createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(10)]), format: 'der', type: 'spki' }),
  };
}

// { algorithm, keyId, signature, trustedComment, globalSignature, fields }
// from the content of a Tauri .sig file. `fields` holds the trusted comment's
// tab-separated `name:value` pairs (timestamp, file, version).
export function parseSignature(base64) {
  const lines = decodeBase64Text(base64, 'the signature');
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  const algorithm = raw.toString('latin1', 0, 2);
  if (raw.length !== 74 || (algorithm !== 'ED' && algorithm !== 'Ed')) throw new Error('unsupported minisign signature');
  const prefix = 'trusted comment: ';
  if (!lines[2]?.startsWith(prefix)) throw new Error('the signature has no trusted comment');
  const trustedComment = lines[2].slice(prefix.length);
  const globalSignature = Buffer.from(lines[3] ?? '', 'base64');
  if (globalSignature.length !== 64) throw new Error('the signature has no global signature');
  const fields = Object.fromEntries(trustedComment.split('\t').map((field) => {
    const colon = field.indexOf(':');
    return colon === -1 ? [field, ''] : [field.slice(0, colon), field.slice(colon + 1)];
  }));
  return {
    algorithm,
    keyId: raw.subarray(2, 10).toString('hex'),
    signature: raw.subarray(10),
    trustedComment,
    globalSignature,
    fields,
  };
}

async function blake2b512(path) {
  const digest = createHash('blake2b512');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest();
}

// Throws unless `signatureBase64` is a valid signature of the file at `path`
// by `publicKeyBase64`, and, when `expectedVersion` is given, signs exactly
// that version. Returns the parsed signature.
export async function verifyUpdaterSignature({ publicKeyBase64, signatureBase64, path, expectedVersion }) {
  const publicKey = parsePublicKey(publicKeyBase64);
  const signature = parseSignature(signatureBase64);
  if (signature.keyId !== publicKey.keyId) {
    throw new Error(`signed by key ${signature.keyId}, the configured key is ${publicKey.keyId}`);
  }
  const message = signature.algorithm === 'ED' ? await blake2b512(path) : readFileSync(path);
  if (!verify(null, message, publicKey.key, signature.signature)) throw new Error('the signature does not match the file');
  const global = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, 'utf8')]);
  if (!verify(null, global, publicKey.key, signature.globalSignature)) throw new Error('the trusted comment was altered');
  if (expectedVersion !== undefined && signature.fields.version !== expectedVersion) {
    throw new Error(`signed for version ${signature.fields.version ?? '(none)'}, expected ${expectedVersion}`);
  }
  return signature;
}

async function main() {
  const args = process.argv.slice(2);
  let pubkey;
  let expectedVersion;
  const files = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--pubkey') pubkey = args[++index];
    else if (args[index] === '--version') expectedVersion = args[++index];
    else files.push(args[index]);
  }
  if (!pubkey || files.length === 0) {
    console.error('usage: verify-updater-signature.mjs --pubkey <base64|file> [--version <v>] <payload>...');
    process.exit(2);
  }
  const publicKeyBase64 = existsSync(pubkey) ? readFileSync(pubkey, 'utf8') : pubkey;
  let failed = false;
  for (const file of files) {
    try {
      const signature = await verifyUpdaterSignature({
        publicKeyBase64,
        signatureBase64: readFileSync(`${file}.sig`, 'utf8'),
        path: file,
        expectedVersion,
      });
      console.log(`${file}: valid signature by key ${signature.keyId} (${signature.trustedComment})`);
    } catch (error) {
      console.error(`${file}: ${error.message}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
