import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MARKERS, UNKNOWN_MARKER, hasBundleType, patchBundleType } from '../patch-bundle-type.mjs';

const binary = (...parts) => Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part) : part)));

test('patches the single unknown marker in place with a same-length marker', () => {
  const input = binary('MZ head ', UNKNOWN_MARKER, ' tail');
  const output = patchBundleType(input, 'nsis');
  assert.equal(output.length, input.length);
  assert.deepEqual(output, binary('MZ head ', MARKERS.nsis, ' tail'));
  assert.deepEqual(input, binary('MZ head ', UNKNOWN_MARKER, ' tail'), 'the input buffer is not modified');
});

test('refuses already patched and ambiguous executables', () => {
  assert.throws(() => patchBundleType(binary('x', MARKERS.nsis), 'nsis'), /found 0/);
  assert.throws(() => patchBundleType(binary(UNKNOWN_MARKER, UNKNOWN_MARKER), 'nsis'), /found 2/);
  assert.throws(() => patchBundleType(binary(UNKNOWN_MARKER), 'zip'), /unknown bundle type/);
});

test('a debug binary with match-arm literals only counts as patched without the unknown marker', () => {
  const debug = binary(UNKNOWN_MARKER, MARKERS.deb, MARKERS.nsis, MARKERS.appimage);
  assert.equal(hasBundleType(debug, 'nsis'), false);
  assert.equal(hasBundleType(patchBundleType(debug, 'nsis'), 'nsis'), true);
  const release = binary('code', UNKNOWN_MARKER, 'data');
  assert.equal(hasBundleType(patchBundleType(release, 'nsis'), 'nsis'), true);
  assert.equal(hasBundleType(patchBundleType(release, 'nsis'), 'deb'), false);
});
