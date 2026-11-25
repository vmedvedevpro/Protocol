#!/usr/bin/env node
// Fails when the Linux packages' desktop file and the app's window name drift
// apart (#191). A desktop finds the desktop file of a window, and with it the
// icon in the task manager and the window switcher, by the window's name:
// KWin and GNOME Shell take the Wayland app id as the file name
// (`<app_id>.desktop`), and on X11 desktops match WM_CLASS to StartupWMClass.
// The app names its windows after the product (`Linux app id: <name>` in its
// log, src-tauri/src/linux_desktop/app_id.rs; GTK derives WM_CLASS from the
// same name), tauri-bundler names the desktop file after the product, and the
// template linux/main.desktop sets StartupWMClass to the product name.
//
//   node scripts/release/check-linux-desktop-entry.mjs [--product <name>]
//     [--root <dir>]... [--log <file>]...
//
// --root is an unpacked package (the deb's data, or the AppImage's
// usr/share); --log a log of the packaged app's start. The product name
// defaults to frontend/src-tauri/tauri.conf.json's productName.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APPLICATIONS = 'usr/share/applications';
const HICOLOR = 'usr/share/icons/hicolor';

// The keys of a desktop file's [Desktop Entry] group.
export function parseDesktopEntry(text) {
  const entry = new Map();
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    const equals = line.indexOf('=');
    if (inEntry && equals > 0) entry.set(line.slice(0, equals).trim(), line.slice(equals + 1).trim());
  }
  return entry;
}

// What is wrong with one unpacked package, as messages; none when it agrees.
export function problemsOfRoot(root, product) {
  const directory = join(root, APPLICATIONS);
  if (!existsSync(directory)) return [`${root}: no ${APPLICATIONS}`];
  const files = readdirSync(directory).filter((name) => name.endsWith('.desktop'));
  const expected = `${product}.desktop`;
  if (files.length !== 1 || files[0] !== expected) {
    return [`${root}: ${APPLICATIONS} holds ${JSON.stringify(files)}, expected only ${JSON.stringify(expected)}, named after the app id`];
  }
  const entry = parseDesktopEntry(readFileSync(join(directory, expected), 'utf8'));
  const problems = [];
  const wmClass = entry.get('StartupWMClass');
  if (wmClass !== product) {
    problems.push(`${root}: StartupWMClass is ${JSON.stringify(wmClass)}, expected ${JSON.stringify(product)}`);
  }
  const icon = entry.get('Icon');
  if (!icon) {
    problems.push(`${root}: ${expected} names no Icon`);
  } else {
    const hicolor = join(root, HICOLOR);
    const sizes = existsSync(hicolor) ? readdirSync(hicolor) : [];
    if (!sizes.some((size) => existsSync(join(hicolor, size, 'apps', `${icon}.png`)))) {
      problems.push(`${root}: no ${HICOLOR}/*/apps/${icon}.png for Icon=${icon}`);
    }
  }
  return problems;
}

// The app logs the name it gives its windows; a log without it fails.
export function problemsOfLog(name, text, product) {
  const lines = text.split(/\r?\n/).filter((line) => line.includes('Linux app id: '));
  if (lines.some((line) => line.trimEnd().endsWith(`Linux app id: ${product}`))) return [];
  if (lines.length === 0) return [`${name}: the app did not log its Linux app id`];
  return [`${name}: the app names its windows ${JSON.stringify(lines[0].split('Linux app id: ')[1])}, expected ${JSON.stringify(product)}`];
}

function parseArguments(argv) {
  const options = { product: null, roots: [], logs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case '--product': options.product = value; break;
      case '--root': options.roots.push(value); break;
      case '--log': options.logs.push(value); break;
      default: throw new Error(`Unknown argument ${argv[index]}`);
    }
    if (value === undefined) throw new Error(`${argv[index]} needs a value`);
    index += 1;
  }
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const product = options.product
    ?? JSON.parse(readFileSync(fileURLToPath(new URL('../../frontend/src-tauri/tauri.conf.json', import.meta.url)), 'utf8')).productName;
  if (options.roots.length === 0 && options.logs.length === 0) throw new Error('Nothing to check: pass --root or --log');
  const problems = [
    ...options.roots.flatMap((root) => problemsOfRoot(root, product)),
    ...options.logs.flatMap((log) => problemsOfLog(log, readFileSync(log, 'utf8'), product)),
  ];
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`The desktop file, StartupWMClass and the app id all say ${JSON.stringify(product)}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
