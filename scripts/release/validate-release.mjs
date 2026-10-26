#!/usr/bin/env node
// The `validate` job of release.yml: decides whether a run may build a
// release and what it is called.
//
//   node scripts/release/validate-release.mjs --mode tag --tag v0.3.0 --sha <sha> --releases <file>
//   node scripts/release/validate-release.mjs --mode dry-run [--version 0.3.0] --sha <sha> --releases <file>
//   options: --notes-out <file>  writes the release's CHANGELOG section
//
// A tag run fails on any problem. A dry run (manual dispatch, pull request)
// reports the release rules as warnings, so a branch whose files still say the
// last version can rehearse the build; the version files must always agree.
// `--releases` is the output of `gh api --paginate --slurp repos/<repo>/releases`.
// In GitHub Actions the results also go to $GITHUB_OUTPUT and annotations.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CHANGELOG,
  UPDATER_ENDPOINT,
  VERSION_FILES,
  changelogSection,
  compareVersions,
  isPrerelease,
  parseVersion,
  readVersionFiles,
  unreleasedSection,
  versionFileErrors,
  versionFromTag,
} from './release-lib.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
// `tauri signer sign --app-version` exists from tauri-cli 2.12 (#33); without
// it the signatures carry no version and requireSignedVersion rejects them.
const SIGNED_VERSION_CLI = '2.12.0';

// Updater settings #31 adds to tauri.conf.json; problems as strings.
export function updaterConfigProblems(tauriConf) {
  const updater = tauriConf.plugins?.updater;
  const problems = [];
  if (tauriConf.bundle?.createUpdaterArtifacts !== true) problems.push('bundle.createUpdaterArtifacts is not true');
  if (!updater?.pubkey) problems.push('plugins.updater.pubkey is empty');
  if (!updater?.endpoints?.includes(UPDATER_ENDPOINT)) problems.push(`plugins.updater.endpoints lacks ${UPDATER_ENDPOINT}`);
  if (updater?.requireSignedVersion !== true) problems.push('plugins.updater.requireSignedVersion is not true');
  return problems;
}

// The tauri-cli version pinned in frontend/pnpm-lock.yaml, or null.
export function lockedTauriCli(lockText) {
  return /^ {2}'@tauri-apps\/cli@(\d+\.\d+\.\d+)':/m.exec(lockText)?.[1] ?? null;
}

// Versions of the published (non-draft) releases with a Protocol tag. GitHub's
// prerelease flag is ignored: it marks RCs, but also a broken release taken off
// Latest with `gh release edit --prerelease` (WORKFLOWS_OVERVIEW.md), which
// stays public and keeps its place in the version order.
function publishedVersions(releases) {
  return releases
    .filter((release) => !release.draft && versionFromTag(release.tag_name))
    .map((release) => versionFromTag(release.tag_name));
}

// Pure core of the job. Inputs are already read; `isAncestor` says whether the
// commit is on origin/main. Returns the outputs plus `errors` and `warnings`.
export function validateRelease({
  mode,
  tag,
  inputVersion,
  versionFiles,
  changelogText,
  releases,
  isAncestor,
  tauriConf,
  tauriCliVersion,
}) {
  const errors = [];
  const warnings = [];
  const releaseRule = (message) => (mode === 'tag' ? errors : warnings).push(message);

  let version;
  if (mode === 'tag') {
    version = versionFromTag(tag ?? '');
    if (!version) {
      errors.push(`tag ${tag} is not vX.Y.Z or vX.Y.Z-rc.N`);
      return { errors, warnings };
    }
  } else {
    version = inputVersion || versionFiles.tauriConf;
    if (!parseVersion(version ?? '')) {
      errors.push(`version ${version} is not X.Y.Z or X.Y.Z-rc.N`);
      return { errors, warnings };
    }
  }
  errors.push(...versionFileErrors(versionFiles, version));

  let notes = '';
  const section = changelogSection(changelogText, version);
  if (section.count === 1 && section.body) {
    notes = section.body;
  } else {
    releaseRule(section.count > 1
      ? `${CHANGELOG} has ${section.count} sections for ${version}`
      : `${CHANGELOG} has no non-empty "## Protocol ${version}" section`);
    const unreleased = unreleasedSection(changelogText);
    if (mode !== 'tag' && unreleased.body) notes = unreleased.body;
  }

  if (mode === 'tag' && !isAncestor) errors.push(`the tagged commit is not on origin/main`);

  const published = publishedVersions(releases);
  if (published.includes(version)) {
    releaseRule(`release v${version} is already published`);
  }
  const highest = [...published].sort(compareVersions).at(-1);
  if (highest && compareVersions(version, highest) <= 0) {
    releaseRule(`version ${version} is not above the highest published release ${highest}`);
  }
  const draft = releases.find((release) => release.draft && release.tag_name === `v${version}`);
  if (draft) warnings.push(`a draft for v${version} exists and will be replaced`);

  const updaterProblems = updaterConfigProblems(tauriConf);
  for (const problem of updaterProblems) releaseRule(`updater: ${problem} (#31)`);
  const signedVersion = Boolean(tauriCliVersion) && compareVersions(tauriCliVersion, SIGNED_VERSION_CLI) >= 0;
  if (!signedVersion) {
    releaseRule(`tauri-cli ${tauriCliVersion ?? '(not found)'} cannot sign with --app-version; ${SIGNED_VERSION_CLI} or later is required (#33)`);
  }

  return {
    errors,
    warnings,
    version,
    tag: `v${version}`,
    prerelease: isPrerelease(version),
    firstRelease: published.length === 0,
    updaterConfigured: updaterProblems.length === 0,
    signedVersion,
    notes,
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--')) throw new Error(`unexpected argument ${args[index]}`);
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode !== 'tag' && options.mode !== 'dry-run') {
    console.error('usage: validate-release.mjs --mode tag|dry-run [--tag vX.Y.Z] [--version X.Y.Z] --sha <sha> --releases <file> [--notes-out <file>]');
    process.exit(2);
  }
  const releasesJson = options.releases ? JSON.parse(readFileSync(options.releases, 'utf8')) : [];
  const releases = releasesJson.flat();
  let isAncestor = false;
  if (options.mode === 'tag') {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', options.sha, 'origin/main'], { cwd: root, stdio: 'ignore' });
      isAncestor = true;
    } catch {
      isAncestor = false;
    }
  }
  const result = validateRelease({
    mode: options.mode,
    tag: options.tag,
    inputVersion: options.version,
    versionFiles: readVersionFiles(root),
    changelogText: readFileSync(join(root, CHANGELOG), 'utf8'),
    releases,
    isAncestor,
    tauriConf: JSON.parse(readFileSync(join(root, VERSION_FILES.tauriConf), 'utf8')),
    tauriCliVersion: lockedTauriCli(readFileSync(join(root, 'frontend/pnpm-lock.yaml'), 'utf8')),
  });

  const annotate = process.env.GITHUB_ACTIONS === 'true';
  for (const warning of result.warnings) console.log(annotate ? `::warning::${warning}` : `warning: ${warning}`);
  for (const error of result.errors) console.log(annotate ? `::error::${error}` : `error: ${error}`);
  if (result.errors.length > 0) process.exit(1);

  if (options['notes-out']) writeFileSync(options['notes-out'], `${result.notes}\n`);
  const outputs = {
    version: result.version,
    tag: result.tag,
    prerelease: result.prerelease,
    first_release: result.firstRelease,
    updater_configured: result.updaterConfigured,
    signed_version: result.signedVersion,
  };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(`${options.mode === 'tag' ? 'Release' : 'Dry run'} of ${result.tag} validated: ${JSON.stringify(outputs)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
