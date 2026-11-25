#!/usr/bin/env node
// The GStreamer plugins the AppImage carries for the meeting screen's player.
//
// WebKitGTK plays <audio> through GStreamer. The AppImage's AppRun points
// GStreamer at the plugin directory inside the image only
// (GST_PLUGIN_SYSTEM_PATH_1_0=$APPDIR/usr/lib/gstreamer-1.0), so an image
// without plugins has no autoaudiosink, and WebKitWebProcess aborts as soon as
// a meeting opens (the 1.0.0 RC). bundle.linux.appimage.bundleMediaFramework
// (tauri.linux.conf.json) runs linuxdeploy-plugin-gstreamer, which copies
// every file of GSTREAMER_PLUGINS_DIR into the image with the libraries they
// need. The Linux leg points that variable at a directory `stage` fills with
// the plugins below only, not the build system's whole plugin directory, so
// the image carries the same set wherever it is built.
//
//   node scripts/release/appimage-gstreamer.mjs stage <system plugin dir> <target dir>
//   node scripts/release/appimage-gstreamer.mjs check <unsquashfs -l listing> <AppRun hook>
//
// `check` fails when the image lacks one of the plugins or the plugin
// scanner, or when the AppRun hook does not point GStreamer at them.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// What the player opens: recordings are AAC in MP4 (audio/encode.rs); an
// import keeps its file as audio.<extension> (audio/import.rs), served as
// recording_stream.rs's content_type says. Plugin names are file names,
// libgst<name>.so; the comment names the Ubuntu 22.04 package.
export const PLUGINS = [
  // playbin, decodebin and the queues, type detection and conversion around the sink
  { name: 'coreelements', for: 'queue, typefind, fakesink' }, // libgstreamer1.0-0
  { name: 'playback', for: 'playbin, decodebin, playsink' }, // gstreamer1.0-plugins-base
  { name: 'typefindfunctions', for: 'detecting the container' }, // gstreamer1.0-plugins-base
  { name: 'audioconvert', for: 'playsink' }, // gstreamer1.0-plugins-base
  { name: 'audioresample', for: 'playsink' }, // gstreamer1.0-plugins-base
  { name: 'volume', for: 'playsink, the volume' }, // gstreamer1.0-plugins-base
  { name: 'audiofx', for: 'scaletempo: speeds other than 1x keep their pitch' }, // gstreamer1.0-plugins-good
  // WebKit builds its video branch for <audio> too, and connects signals to
  // these elements without checking that they exist (GLib criticals)
  { name: 'app', for: 'appsink, WebKit\'s video sink' }, // gstreamer1.0-plugins-base
  { name: 'debugutilsbad', for: 'fakevideosink' }, // gstreamer1.0-plugins-bad
  // sinks: autoaudiosink takes the highest-ranked sink that opens, else its
  // own fakesink (coreelements), so a session without sound still plays.
  // pulsesink also reaches PipeWire through pipewire-pulse; pipewiresink has
  // rank none, so autoaudiosink never picks it.
  { name: 'autodetect', for: 'autoaudiosink' }, // gstreamer1.0-plugins-good
  { name: 'pulseaudio', for: 'pulsesink' }, // gstreamer1.0-plugins-good
  { name: 'alsa', for: 'alsasink, without a sound server' }, // gstreamer1.0-alsa
  // containers and decoders
  { name: 'isomp4', for: 'qtdemux: MP4, M4A' }, // gstreamer1.0-plugins-good
  { name: 'audioparsers', for: 'aacparse, mpegaudioparse, flacparse' }, // gstreamer1.0-plugins-good
  { name: 'faad', for: 'AAC: recordings, M4A, AAC' }, // gstreamer1.0-plugins-bad
  { name: 'wavparse', for: 'WAV' }, // gstreamer1.0-plugins-good
  { name: 'id3demux', for: 'MP3 with ID3 tags' }, // gstreamer1.0-plugins-good
  { name: 'mpg123', for: 'MP3' }, // gstreamer1.0-plugins-good
  { name: 'flac', for: 'FLAC' }, // gstreamer1.0-plugins-good
  { name: 'ogg', for: 'OGG' }, // gstreamer1.0-plugins-base
  { name: 'vorbis', for: 'Vorbis in OGG and WebM' }, // gstreamer1.0-plugins-base
  { name: 'opus', for: 'Opus in OGG and WebM' }, // gstreamer1.0-plugins-base
  { name: 'matroska', for: 'WebM' }, // gstreamer1.0-plugins-good
];

export const pluginFile = (plugin) => `libgst${plugin.name}.so`;

// Where linuxdeploy-plugin-gstreamer puts plugins and helpers in the image.
export const IMAGE_PLUGIN_DIR = 'usr/lib/gstreamer-1.0';
export const IMAGE_SCANNER = 'usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner';
export const HOOK = 'apprun-hooks/linuxdeploy-plugin-gstreamer.sh';
// The hook must hand GStreamer the image's plugins and its own scanner: the
// scanner compiled into libgstreamer is the system's, built against the
// system's libraries.
const HOOK_EXPORTS = {
  GST_PLUGIN_SYSTEM_PATH_1_0: `\${APPDIR}/${IMAGE_PLUGIN_DIR}`,
  GST_PLUGIN_SCANNER_1_0: `\${APPDIR}/${IMAGE_SCANNER}`,
};

// Copies the plugins from the system's plugin directory. Missing ones are
// all named before it throws: the leg's apt step lacks a package.
export function stage(systemDir, targetDir, { plugins = PLUGINS, copy = copyFileSync, exists = existsSync } = {}) {
  const missing = plugins.filter((plugin) => !exists(join(systemDir, pluginFile(plugin))));
  if (missing.length > 0) {
    throw new Error(`${systemDir} lacks ${missing.map(pluginFile).join(', ')}: install the GStreamer plugin packages`);
  }
  mkdirSync(targetDir, { recursive: true });
  for (const plugin of plugins) copy(join(systemDir, pluginFile(plugin)), join(targetDir, pluginFile(plugin)));
  return plugins.map(pluginFile);
}

// The paths of an `unsquashfs -l` listing, without its squashfs-root/ prefix.
export function imagePaths(listing) {
  return new Set(listing.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('squashfs-root/'))
    .map((line) => line.slice('squashfs-root/'.length)));
}

// The NAME="value" assignments the hook exports.
export function hookExports(hook) {
  const exports = {};
  for (const match of hook.matchAll(/^\s*export\s+([A-Z0-9_]+)="([^"]*)"\s*$/gm)) exports[match[1]] = match[2];
  return exports;
}

export function problemsOf(listing, hook, { plugins = PLUGINS } = {}) {
  const paths = imagePaths(listing);
  const problems = [];
  const missing = plugins.filter((plugin) => !paths.has(`${IMAGE_PLUGIN_DIR}/${pluginFile(plugin)}`));
  if (missing.length > 0) {
    problems.push(`the AppImage lacks ${missing.map((plugin) => `${IMAGE_PLUGIN_DIR}/${pluginFile(plugin)} (${plugin.for})`).join(', ')}`);
  }
  if (!paths.has(IMAGE_SCANNER)) problems.push(`the AppImage lacks ${IMAGE_SCANNER}`);
  if (!paths.has(HOOK)) problems.push(`the AppImage lacks ${HOOK}`);
  if (hook === null) {
    problems.push(`no ${HOOK} to read`);
  } else {
    const exports = hookExports(hook);
    for (const [name, value] of Object.entries(HOOK_EXPORTS)) {
      if (exports[name] !== value) problems.push(`${HOOK} sets ${name}=${exports[name] ?? '(nothing)'}, not ${value}`);
    }
  }
  return problems;
}

function main([command, ...args]) {
  if (command === 'stage' && args.length === 2) {
    const files = stage(args[0], args[1]);
    console.log(`Staged ${files.length} GStreamer plugins in ${args[1]}: ${files.join(' ')}`);
    return;
  }
  if (command === 'check' && args.length === 2) {
    const hook = existsSync(args[1]) ? readFileSync(args[1], 'utf8') : null;
    const problems = problemsOf(readFileSync(args[0], 'utf8'), hook);
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      console.error('The AppImage cannot play recordings: WebKitWebProcess aborts when a meeting opens.');
      process.exit(1);
    }
    console.log(`The AppImage carries ${PLUGINS.length} GStreamer plugins and its plugin scanner, and AppRun points GStreamer at them.`);
    return;
  }
  throw new Error('usage: appimage-gstreamer.mjs stage <system plugin dir> <target dir> | check <unsquashfs -l listing> <AppRun hook>');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
