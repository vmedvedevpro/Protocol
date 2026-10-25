import type { UpdaterSnapshot } from '../../src/lib/updater';

export const snapshot = (overrides: Partial<UpdaterSnapshot> = {}): UpdaterSnapshot => ({
  currentVersion: '0.3.0',
  platform: 'windows',
  support: { kind: 'updatable', install: 'nsis' },
  autoCheck: true,
  lastCheckedAt: null,
  activity: { state: 'idle' },
  offer: null,
  error: null,
  busyReasons: [],
  updatedFrom: null,
  ...overrides,
});

export const offered = (version = '0.3.1', extra: Partial<NonNullable<UpdaterSnapshot['offer']>> = {}) => ({
  release: { version, notes: '## Fixed\n\n- Recording no longer stops on sleep.', date: '2026-10-20T10:00:00Z' },
  downloaded: false,
  manualOnly: false,
  waitingForRecording: false,
  ...extra,
});
