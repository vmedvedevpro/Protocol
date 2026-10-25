import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { UPDATER_ENDPOINT } from '../release-lib.mjs';
import { lockedTauriCli, updaterConfigProblems, validateRelease } from '../validate-release.mjs';
import { repoRoot } from './helpers.mjs';

const files = (version) => ({ tauriConf: version, cargoToml: version, cargoLock: version, packageJson: version });
const updaterConf = {
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey: 'key', endpoints: [UPDATER_ENDPOINT], requireSignedVersion: true } },
};
const changelog = '# Changelog\n\n## Protocol — unreleased\n\n- Next.\n\n## Protocol 0.3.0 — 2026-10-30\n\n- First.\n';
const release = (tag, { draft = false, prerelease = false } = {}) => ({ tag_name: tag, draft, prerelease });

const tagRun = (overrides = {}) => validateRelease({
  mode: 'tag',
  tag: 'v0.3.0',
  versionFiles: files('0.3.0'),
  changelogText: changelog,
  releases: [],
  isAncestor: true,
  tauriConf: updaterConf,
  tauriCliVersion: '2.12.4',
  ...overrides,
});

test('a complete tag run passes with its outputs', () => {
  const result = tagRun();
  assert.deepEqual(result.errors, []);
  assert.equal(result.version, '0.3.0');
  assert.equal(result.tag, 'v0.3.0');
  assert.equal(result.prerelease, false);
  assert.equal(result.firstRelease, true);
  assert.equal(result.notes, '- First.');
  assert.equal(result.updaterConfigured, true);
  assert.equal(result.signedVersion, true);
});

test('a tag run fails on each release rule', () => {
  const cases = [
    [{ tag: 'v0.3' }, /is not vX\.Y\.Z/],
    [{ tag: 'release-0.3.0' }, /is not vX\.Y\.Z/],
    [{ versionFiles: { ...files('0.3.0'), cargoLock: '0.2.22' } }, /Cargo\.lock has version 0\.2\.22/],
    [{ changelogText: '## Protocol — unreleased\n\n- Next.\n' }, /no non-empty "## Protocol 0\.3\.0" section/],
    [{ changelogText: '## Protocol 0.3.0\n\n## Unreleased\n' }, /no non-empty/],
    [{ isAncestor: false }, /not on origin\/main/],
    [{ releases: [release('v0.3.0')] }, /already published/],
    [{ releases: [release('v0.4.0')] }, /not above the latest published release 0\.4\.0/],
    [{ tauriConf: {} }, /createUpdaterArtifacts/],
    [{ tauriConf: { ...updaterConf, plugins: { updater: { ...updaterConf.plugins.updater, requireSignedVersion: false } } } }, /requireSignedVersion/],
    [{ tauriConf: { ...updaterConf, plugins: { updater: { ...updaterConf.plugins.updater, endpoints: [] } } } }, /endpoints/],
    [{ tauriCliVersion: '2.11.4' }, /--app-version/],
  ];
  for (const [overrides, pattern] of cases) {
    const result = tagRun(overrides);
    assert.ok(result.errors.some((error) => pattern.test(error)), `${JSON.stringify(overrides)}: ${result.errors}`);
  }
});

test('drafts, prereleases and other tags do not count as published', () => {
  const result = tagRun({
    releases: [release('v0.3.0', { draft: true }), release('v0.9.0', { draft: true }), release('v0.3.0-rc.1', { prerelease: true }), release('upstream-1.0')],
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => /draft for v0\.3\.0 exists/.test(warning)));
  assert.equal(result.firstRelease, true);
});

test('an RC must be above the latest stable and the previous RC of its version', () => {
  const rc = (tag, releases) => tagRun({
    tag,
    versionFiles: files(tag.slice(1)),
    changelogText: `## Protocol ${tag.slice(1)}\n\n- RC.\n`,
    releases,
  });
  assert.deepEqual(rc('v0.3.1-rc.2', [release('v0.3.0'), release('v0.3.1-rc.1', { prerelease: true })]).errors, []);
  assert.equal(rc('v0.3.1-rc.2', []).prerelease, true);
  assert.match(rc('v0.3.1-rc.1', [release('v0.3.1-rc.1', { prerelease: true })]).errors.join(), /already published/);
  assert.match(rc('v0.3.1-rc.1', [release('v0.3.1-rc.3', { prerelease: true })]).errors.join(), /not above the published 0\.3\.1-rc\.3/);
  assert.match(rc('v0.3.0-rc.1', [release('v0.3.0')]).errors.join(), /not above the latest published release/);
});

test('a dry run turns release rules into warnings but keeps the version files strict', () => {
  const dry = validateRelease({
    mode: 'dry-run',
    versionFiles: files('0.2.22'),
    changelogText: changelog,
    releases: [release('v0.2.22')],
    isAncestor: false,
    tauriConf: {},
    tauriCliVersion: '2.11.4',
  });
  assert.deepEqual(dry.errors, []);
  assert.equal(dry.version, '0.2.22');
  assert.equal(dry.notes, '- Next.', 'falls back to the unreleased section');
  assert.equal(dry.updaterConfigured, false);
  assert.equal(dry.signedVersion, false);
  for (const pattern of [/no non-empty/, /already published/, /createUpdaterArtifacts/, /--app-version/]) {
    assert.ok(dry.warnings.some((warning) => pattern.test(warning)), String(pattern));
  }
  const mismatch = validateRelease({
    mode: 'dry-run',
    inputVersion: '0.3.0',
    versionFiles: files('0.2.22'),
    changelogText: changelog,
    releases: [],
    tauriConf: updaterConf,
    tauriCliVersion: '2.12.4',
  });
  assert.equal(mismatch.errors.length, 4);
});

test('the checked-in config and lockfile are read the way validate reads them', () => {
  const conf = JSON.parse(readFileSync(join(repoRoot, 'frontend/src-tauri/tauri.conf.json'), 'utf8'));
  assert.ok(Array.isArray(updaterConfigProblems(conf)));
  assert.match(lockedTauriCli(readFileSync(join(repoRoot, 'frontend/pnpm-lock.yaml'), 'utf8')), /^2\.\d+\.\d+$/);
  assert.equal(lockedTauriCli("  '@tauri-apps/cli@2.12.4':\n    resolution: {}\n"), '2.12.4');
});
