import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOOK, IMAGE_PLUGIN_DIR, IMAGE_SCANNER, PLUGINS, hookExports, pluginFile, problemsOf, stage } from '../appimage-gstreamer.mjs';
import { withTempDir } from './helpers.mjs';

// The hook linuxdeploy-plugin-gstreamer writes (tauri-cli 2.12.6).
const hook = `#! /bin/bash

export GST_REGISTRY_REUSE_PLUGIN_SCANNER="no"
export GST_PLUGIN_SYSTEM_PATH_1_0="\${APPDIR}/usr/lib/gstreamer-1.0"
export GST_PLUGIN_PATH_1_0="\${APPDIR}/usr/lib/gstreamer-1.0"

export GST_PLUGIN_SCANNER_1_0="\${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
export GST_PTP_HELPER_1_0="\${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-ptp-helper"
`;

// unsquashfs -l prints one path per line under squashfs-root.
const listing = (paths) => ['squashfs-root', ...paths.map((path) => `squashfs-root/${path}`)].join('\n') + '\n';
const complete = [
  'AppRun',
  HOOK,
  'usr/bin/protocol',
  IMAGE_PLUGIN_DIR,
  ...PLUGINS.map((plugin) => `${IMAGE_PLUGIN_DIR}/${pluginFile(plugin)}`),
  IMAGE_SCANNER,
];

test('an image with every plugin, the scanner and the hook passes', () => {
  assert.deepEqual(problemsOf(listing(complete), hook), []);
});

test('the 1.0.0 RC image, without plugins or hook, fails on each', () => {
  const problems = problemsOf(listing(['AppRun', 'usr/bin/protocol', 'usr/lib/libgstreamer-1.0.so.0']), null);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /lacks usr\/lib\/gstreamer-1.0\/libgstcoreelements.so .*libgstautodetect.so \(autoaudiosink\)/);
  assert.match(problems.join('\n'), /lacks usr\/lib\/gstreamer1.0\/gstreamer-1.0\/gst-plugin-scanner/);
  assert.match(problems.join('\n'), /no apprun-hooks\/linuxdeploy-plugin-gstreamer.sh to read/);
});

test('names each missing plugin with what the player needs it for', () => {
  const problems = problemsOf(listing(complete.filter((path) => !/libgst(faad|autodetect)\.so$/.test(path))), hook);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /libgstautodetect.so \(autoaudiosink\), .*libgstfaad.so \(AAC/);
});

test('a hook that points GStreamer elsewhere fails', () => {
  const system = hook.replace('GST_PLUGIN_SYSTEM_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"',
    'GST_PLUGIN_SYSTEM_PATH_1_0="/usr/lib/x86_64-linux-gnu/gstreamer-1.0"');
  assert.match(problemsOf(listing(complete), system).join('\n'),
    /sets GST_PLUGIN_SYSTEM_PATH_1_0=\/usr\/lib\/x86_64-linux-gnu\/gstreamer-1.0, not \$\{APPDIR\}\/usr\/lib\/gstreamer-1.0/);
  const noScanner = hook.replace(/^export GST_PLUGIN_SCANNER_1_0=.*$/m, '');
  assert.match(problemsOf(listing(complete), noScanner).join('\n'), /sets GST_PLUGIN_SCANNER_1_0=\(nothing\)/);
});

test('reads the hook exports', () => {
  assert.equal(hookExports(hook).GST_REGISTRY_REUSE_PLUGIN_SCANNER, 'no');
  assert.equal(Object.keys(hookExports(hook)).length, 5);
});

test('a plugin name elsewhere in the image does not count', () => {
  const elsewhere = complete.map((path) => path.replace(`${IMAGE_PLUGIN_DIR}/libgstfaad.so`, 'usr/lib/libgstfaad.so'));
  assert.match(problemsOf(listing(elsewhere), hook).join('\n'), /lacks usr\/lib\/gstreamer-1.0\/libgstfaad.so/);
});

test('stage copies exactly the listed plugins and leaves the rest of the system directory', async () => {
  await withTempDir((dir) => {
    const system = join(dir, 'system');
    const target = join(dir, 'staged');
    const files = [...PLUGINS.map(pluginFile), 'libgstvaapi.so', 'libgstlibav.so'];
    mkdirSync(system);
    for (const file of files) writeFileSync(join(system, file), file);
    assert.deepEqual(stage(system, target), PLUGINS.map(pluginFile));
    assert.deepEqual(readdirSync(target).sort(), PLUGINS.map(pluginFile).sort());
  });
});

test('stage names every missing plugin before it copies anything', () => {
  const copied = [];
  assert.throws(
    () => stage('/usr/lib/x86_64-linux-gnu/gstreamer-1.0', '/nonexistent', {
      exists: (path) => !/libgst(alsa|faad)\.so$/.test(path),
      copy: (from) => copied.push(from),
    }),
    /lacks libgstalsa.so, libgstfaad.so: install the GStreamer plugin packages/,
  );
  assert.deepEqual(copied, []);
});

test('the plugin list has no duplicates', () => {
  assert.equal(new Set(PLUGINS.map((plugin) => plugin.name)).size, PLUGINS.length);
});
