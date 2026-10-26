import { expect, mock, test } from 'bun:test';

mock.module('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));
mock.module('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const lib = await import('../../src/lib/updater');
const { statusLine, AUTO_CHECK_DESCRIPTION } = await import('../../src/components/updater/UpdateSettings');
const { indicatorLabel } = await import('../../src/components/updater/UpdateIndicator');
const { DOWNLOAD_NOTE, offerLine, blockedLine } = await import('../../src/components/updater/UpdatePanel');
const { snapshot, offered } = await import('./fixtures');

const NOW = Date.parse('2026-10-26T12:00:00Z');

test('every text about automatic checks says the download waits for a click', () => {
  for (const text of [AUTO_CHECK_DESCRIPTION, DOWNLOAD_NOTE]) {
    expect(text).toContain('only when you click Download');
  }
});

test('the status line follows the snapshot', () => {
  expect(statusLine(snapshot(), NOW)).toBe('Not checked yet.');
  expect(statusLine(snapshot({ lastCheckedAt: NOW - 2 * 3600_000 }), NOW)).toBe('Protocol is up to date. Last checked 2 hours ago.');
  expect(statusLine(snapshot({ activity: { state: 'checking', manual: true } }), NOW)).toBe('Checking for updates…');
  expect(statusLine(snapshot({ offer: offered() }), NOW)).toBe('Protocol 0.3.1 is available.');
  expect(statusLine(snapshot({ offer: offered('0.3.1', { downloaded: true }) }), NOW)).toBe('Protocol 0.3.1 is ready to install.');
  expect(statusLine(snapshot({ offer: offered('0.3.1', { waitingForRecording: true }) }), NOW)).toContain('starts after the recording');
  expect(statusLine(snapshot({ offer: offered(), activity: { state: 'downloading', received: 25, total: 100 } }), NOW))
    .toBe('Downloading Protocol 0.3.1… 25%');
  expect(statusLine(snapshot({ support: { kind: 'off', reason: 'dev' } }), NOW)).toBe('Updates are off in development builds.');
  expect(statusLine(snapshot({ support: { kind: 'off', reason: 'notInstalled' } }), NOW)).toContain('not installed by the Protocol installer');
});

test('a failed manual check is shown and a failed background check is not', () => {
  const error = { kind: 'network' as const, action: 'check' as const, message: 'timed out', at: NOW, background: false };
  expect(statusLine(snapshot({ error }), NOW)).toContain("Couldn't reach GitHub");
  expect(statusLine(snapshot({ error: { ...error, background: true }, lastCheckedAt: NOW }), NOW)).toContain('up to date');
});

test('the pill appears only while a release is offered', () => {
  expect(indicatorLabel(snapshot())).toBeNull();
  expect(indicatorLabel(snapshot({ offer: offered() }))).toBe('Update available · 0.3.1');
  expect(indicatorLabel(snapshot({ offer: offered(), activity: { state: 'downloading', received: 50, total: 200 } }))).toBe('Downloading · 25%');
  expect(indicatorLabel(snapshot({ offer: offered(), activity: { state: 'downloading', received: 50, total: null } }))).toBe('Downloading · 0.3.1');
  expect(indicatorLabel(snapshot({ offer: offered('0.3.1', { downloaded: true }) }))).toBe('Restart and update · 0.3.1');
  const failed = { kind: 'download' as const, action: 'download' as const, message: 'reset', at: NOW, background: false };
  expect(indicatorLabel(snapshot({ offer: offered(), error: failed }))).toBe('Update failed · 0.3.1');
});

test('Restart and update names the first reason it cannot run', () => {
  const ready = snapshot({ offer: offered('0.3.1', { downloaded: true }) });
  expect(blockedLine(ready, [])).toBeNull();
  expect(blockedLine({ ...ready, busyReasons: ['summary', 'import'] }, [])).toBe("Protocol can't restart while a summary is being generated.");
  expect(blockedLine(ready, ['recording'])).toBe("Protocol can't restart while a recording is in progress.");
  expect(blockedLine(snapshot({ offer: offered(), busyReasons: ['recording'] }), [])).toBeNull();
  expect(offerLine(ready)).toContain('closes for about half a minute');
});

test('every busy reason and error kind has wording', () => {
  const reasons = ['recording', 'recordingStopping', 'recordingSave', 'import', 'retranscription', 'diarization', 'summary', 'postCall', 'modelDownload', 'onboarding', 'speechEngine'] as const;
  for (const reason of reasons) expect(lib.busySentence(reason)).not.toContain('undefined');
  const kinds = ['network', 'noRelease', 'noPlatform', 'feed', 'signature', 'download', 'diskSpace', 'installStart', 'installIncomplete', 'location'] as const;
  for (const kind of kinds) {
    const text = lib.errorSentence({ kind, action: 'install', message: 'm', at: 0, background: false }, 'macos', '0.3.1', '0.3.0');
    expect(text.length).toBeGreaterThan(10);
  }
  expect(lib.errorSentence({ kind: 'installIncomplete', action: 'install', message: '', at: 0, background: true }, 'windows', '0.3.1', '0.3.0'))
    .toBe("The update to 0.3.1 didn't finish. Protocol is still on 0.3.0.");
});

test('relative times and download percentages', () => {
  expect(lib.relativeTime(NOW - 10_000, NOW)).toBe('just now');
  expect(lib.relativeTime(NOW - 60_000, NOW)).toBe('1 minute ago');
  expect(lib.relativeTime(NOW - 26 * 3600_000, NOW)).toBe('yesterday');
  expect(lib.relativeTime(NOW - 3 * 86400_000, NOW)).toBe('3 days ago');
  expect(lib.downloadPercent({ state: 'downloading', received: 1, total: 3 })).toBe(33);
  expect(lib.downloadPercent({ state: 'downloading', received: 5, total: 3 })).toBe(100);
  expect(lib.downloadPercent({ state: 'idle' })).toBeNull();
});

test('ui activity listeners see the whole set and only real changes', () => {
  const seen: string[][] = [];
  const stop = lib.onUiActivity((activities) => seen.push(activities));
  lib.markUiActivity('postCall', true);
  lib.markUiActivity('postCall', true);
  lib.markUiActivity('recordingSave', true);
  lib.markUiActivity('postCall', false);
  stop();
  lib.markUiActivity('recordingSave', false);
  expect(seen).toEqual([['postCall'], ['postCall', 'recordingSave'], ['recordingSave']]);
  expect(lib.currentUiActivity()).toEqual([]);
});
