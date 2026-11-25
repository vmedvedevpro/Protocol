import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDesktopEntry, problemsOfLog, problemsOfRoot } from '../check-linux-desktop-entry.mjs';
import { repoRoot, withTempDir } from './helpers.mjs';

// What tauri-bundler renders from linux/main.desktop for the 1.0 deb.
const rendered = (wmClass) => `[Desktop Entry]
Categories=
Comment=Protocol: a local-first meeting recorder and transcriber
Exec=protocol
StartupWMClass=${wmClass}
Icon=protocol
Name=Protocol
Terminal=false
Type=Application
`;

function makePackage(root, { file = 'Protocol.desktop', wmClass = 'Protocol', icon = true } = {}) {
  mkdirSync(join(root, 'usr/share/applications'), { recursive: true });
  writeFileSync(join(root, 'usr/share/applications', file), rendered(wmClass));
  if (icon) {
    mkdirSync(join(root, 'usr/share/icons/hicolor/128x128/apps'), { recursive: true });
    writeFileSync(join(root, 'usr/share/icons/hicolor/128x128/apps/protocol.png'), '');
  }
}

test('reads only the [Desktop Entry] group', () => {
  const entry = parseDesktopEntry('# c\n[Desktop Entry]\nName=Protocol\nIcon = protocol\n[Desktop Action x]\nName=Other\n');
  assert.equal(entry.get('Name'), 'Protocol');
  assert.equal(entry.get('Icon'), 'protocol');
});

test('accepts a package whose desktop file, StartupWMClass and icon agree', async () => {
  await withTempDir((root) => {
    makePackage(root);
    assert.deepEqual(problemsOfRoot(root, 'Protocol'), []);
  });
});

test("fails the tauri-bundler default, StartupWMClass set to the executable's name", async () => {
  await withTempDir((root) => {
    makePackage(root, { wmClass: 'protocol' });
    assert.match(problemsOfRoot(root, 'Protocol').join('\n'), /StartupWMClass is "protocol", expected "Protocol"/);
  });
});

test('fails a desktop file named after something else, and a missing icon', async () => {
  await withTempDir((root) => {
    makePackage(root, { file: 'protocol.desktop', icon: false });
    assert.match(problemsOfRoot(root, 'Protocol').join('\n'), /expected only "Protocol.desktop"/);
  });
  await withTempDir((root) => {
    makePackage(root, { icon: false });
    assert.match(problemsOfRoot(root, 'Protocol').join('\n'), /no usr\/share\/icons\/hicolor\/\*\/apps\/protocol.png/);
  });
});

test("checks the app id in the app's log", () => {
  const line = '[2026-11-26T01:00:00Z INFO  app_lib::linux_desktop::app_id] Linux app id: Protocol';
  assert.deepEqual(problemsOfLog('log', `a\n${line}\nb`, 'Protocol'), []);
  assert.match(problemsOfLog('log', line.replace(': Protocol', ': protocol'), 'Protocol').join(), /names its windows "protocol"/);
  assert.match(problemsOfLog('log', 'nothing', 'Protocol').join(), /did not log its Linux app id/);
});

test('the template the packages use sets StartupWMClass to the product name', () => {
  const template = readFileSync(join(repoRoot, 'frontend/src-tauri/linux/main.desktop'), 'utf8');
  assert.equal(parseDesktopEntry(template).get('StartupWMClass'), '{{name}}');
  const linux = JSON.parse(readFileSync(join(repoRoot, 'frontend/src-tauri/tauri.linux.conf.json'), 'utf8'));
  assert.equal(linux.bundle.linux.deb.desktopTemplate, 'linux/main.desktop');
});
