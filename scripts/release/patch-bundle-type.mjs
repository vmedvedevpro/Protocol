#!/usr/bin/env node
// Writes Tauri's bundle-type marker into an executable that the bundler never
// saw, the way tauri-bundler's patch_binary does for the main binary.
//
// tauri-utils keeps `static mut __TAURI_BUNDLE_TYPE = "__TAURI_BUNDLE_TYPE_VAR_UNK"`;
// the bundler overwrites those bytes in place with a same-length marker such as
// `__TAURI_BUNDLE_TYPE_VAR_NSS`. tauri-plugin-updater reads it to pick the
// `windows-x86_64-nsis` feed entry. The Windows installer replaces the bundled
// CPU protocol.exe with protocol-vulkan.exe, a plain cargo build, so that file
// must be patched before it is packaged or Vulkan installs report no bundle type.
//
//   node scripts/release/patch-bundle-type.mjs <exe> nsis
//   node scripts/release/patch-bundle-type.mjs --check <exe> nsis
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PREFIX = '__TAURI_BUNDLE_TYPE_VAR_';
export const UNKNOWN_MARKER = Buffer.from(`${PREFIX}UNK`);
export const MARKERS = {
  nsis: Buffer.from(`${PREFIX}NSS`),
  msi: Buffer.from(`${PREFIX}MSI`),
  deb: Buffer.from(`${PREFIX}DEB`),
  rpm: Buffer.from(`${PREFIX}RPM`),
  appimage: Buffer.from(`${PREFIX}APP`),
};

function markerFor(type) {
  const marker = MARKERS[type];
  if (!marker) throw new Error(`unknown bundle type ${type}; expected one of ${Object.keys(MARKERS).join(', ')}`);
  return marker;
}

export function countOccurrences(buffer, needle) {
  let count = 0;
  for (let index = buffer.indexOf(needle); index !== -1; index = buffer.indexOf(needle, index + 1)) {
    count += 1;
  }
  return count;
}

// Returns a patched copy. Exactly one unpatched marker must exist: none means
// the file is already patched or is not a Tauri executable, several mean the
// layout changed and blindly patching the first could hit the wrong bytes.
export function patchBundleType(buffer, type) {
  const marker = markerFor(type);
  const count = countOccurrences(buffer, UNKNOWN_MARKER);
  if (count !== 1) {
    throw new Error(`expected exactly one ${UNKNOWN_MARKER} marker, found ${count}`);
  }
  const patched = Buffer.from(buffer);
  marker.copy(patched, buffer.indexOf(UNKNOWN_MARKER));
  return patched;
}

// An executable carries `type` when no unpatched marker is left and the type's
// marker is present. Debug builds also keep the marker strings of tauri-utils'
// match arms, so presence alone would not prove a patch; absence of UNK does.
export function hasBundleType(buffer, type) {
  return countOccurrences(buffer, UNKNOWN_MARKER) === 0 && countOccurrences(buffer, markerFor(type)) > 0;
}

function main() {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  const [file, type] = check ? args.slice(1) : args;
  if (!file || !type) {
    console.error('usage: patch-bundle-type.mjs [--check] <executable> <nsis|msi|deb|rpm|appimage>');
    process.exit(2);
  }
  const buffer = readFileSync(file);
  if (check) {
    if (!hasBundleType(buffer, type)) {
      console.error(`${file} does not carry the ${type} bundle-type marker`);
      process.exit(1);
    }
    console.log(`${file} carries the ${type} bundle-type marker.`);
    return;
  }
  writeFileSync(file, patchBundleType(buffer, type));
  console.log(`Patched ${file} with the ${type} bundle-type marker.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
