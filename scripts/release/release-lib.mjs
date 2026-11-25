// Shared rules of the release pipeline (.github/workflows/release.yml): the
// tag and version format, the four files that carry the version, the
// CHANGELOG section of a release, the asset names and the updater feed.
// The CLIs next to this file are thin wrappers so the rules stay testable.
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const REPOSITORY = 'vmedvedevpro/Protocol';
export const UPDATER_ENDPOINT = `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`;
export const TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;

export const VERSION_FILES = {
  tauriConf: 'frontend/src-tauri/tauri.conf.json',
  cargoToml: 'frontend/src-tauri/Cargo.toml',
  cargoLock: 'Cargo.lock',
  packageJson: 'frontend/package.json',
};
export const CHANGELOG = 'CHANGELOG.md';
export const UNRELEASED_HEADING = '## Protocol — unreleased';

// The updater shows notes in a small panel and links to GitHub for the rest
// (#31): latest.json carries at most this many bytes of the CHANGELOG section.
export const FEED_NOTES_LIMIT = 8000;

// { major, minor, patch, rc } for X.Y.Z or X.Y.Z-rc.N (rc is null for a
// stable version), or null when `version` does not have that form.
export function parseVersion(version) {
  const match = TAG_PATTERN.exec(`v${version}`);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rc: match[5] === undefined ? null : Number(match[5]),
  };
}

export function versionFromTag(tag) {
  return TAG_PATTERN.test(tag) ? tag.slice(1) : null;
}

// Semver order for the versions parseVersion accepts: an RC sorts before the
// stable release of the same X.Y.Z.
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error(`cannot compare ${a} and ${b}`);
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.rc === right.rc) return 0;
  if (left.rc === null) return 1;
  if (right.rc === null) return -1;
  return left.rc - right.rc;
}

export function isPrerelease(version) {
  return parseVersion(version)?.rc !== null;
}

// Version strings as written in each file. Cargo.lock has the version of the
// `protocol` package (the app); llama-helper keeps its own version.
export function readVersionFiles(root) {
  const read = (path) => readFileSync(join(root, path), 'utf8');
  return {
    tauriConf: JSON.parse(read(VERSION_FILES.tauriConf)).version ?? null,
    cargoToml: cargoPackageVersion(read(VERSION_FILES.cargoToml)).version,
    cargoLock: LOCK_ENTRY.exec(read(VERSION_FILES.cargoLock))?.[2] ?? null,
    packageJson: JSON.parse(read(VERSION_FILES.packageJson)).version ?? null,
  };
}

const LOCK_ENTRY = /^(\[\[package\]\]\r?\nname = "protocol"\r?\nversion = ")([^"]+)(")/m;
const TOML_VERSION = /^(version\s*=\s*")([^"]+)(".*)$/;

// The `version` line of Cargo.toml's [package] table: { line, version }, or
// { line: -1, version: null }.
function cargoPackageVersion(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('[package]');
  for (let index = start + 1; start !== -1 && index < lines.length && !lines[index].startsWith('['); index += 1) {
    const match = TOML_VERSION.exec(lines[index]);
    if (match) return { line: index, version: match[2] };
  }
  return { line: -1, version: null };
}

// The edits of a release PR to the four version files, as { key: text } with
// the keys of VERSION_FILES. JSON files keep their formatting: only the first
// "version" value changes, and the parse check confirms it is the top-level one.
export function bumpVersionFiles(texts, version) {
  if (!parseVersion(version)) throw new Error(`invalid version ${version}`);
  const result = {};
  for (const key of ['tauriConf', 'packageJson']) {
    const text = texts[key];
    const bumped = text.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`);
    const expected = { ...JSON.parse(text), version };
    if (JSON.stringify(JSON.parse(bumped)) !== JSON.stringify(expected)) {
      throw new Error(`${VERSION_FILES[key]}: the first "version" key is not the top-level version`);
    }
    result[key] = bumped;
  }
  const eol = texts.cargoToml.includes('\r\n') ? '\r\n' : '\n';
  const lines = texts.cargoToml.split(/\r?\n/);
  const { line } = cargoPackageVersion(texts.cargoToml);
  if (line === -1) throw new Error(`${VERSION_FILES.cargoToml}: no version in [package]`);
  lines[line] = lines[line].replace(TOML_VERSION, `$1${version}$3`);
  result.cargoToml = lines.join(eol);
  if (!LOCK_ENTRY.test(texts.cargoLock)) throw new Error(`${VERSION_FILES.cargoLock}: no protocol package`);
  result.cargoLock = texts.cargoLock.replace(LOCK_ENTRY, `$1${version}$3`);
  return result;
}

// Errors for every version file that does not say `version`.
export function versionFileErrors(found, version) {
  return Object.entries(found)
    .filter(([, value]) => value !== version)
    .map(([key, value]) => `${VERSION_FILES[key]} has version ${value ?? '(none)'}, expected ${version}`);
}

// The body of `## Protocol <version>` (with an optional ` — <date>`), up to the
// next `## ` heading. The inherited Actually Free changelog sits under one
// `## Meetily – Actually Free history …` heading, which ends the oldest Protocol
// section; its own sections are `### ` headings (`### Unreleased`,
// `### v0.2.20 …`), so they never match. Returns { count, body } so callers can
// reject a missing or duplicated section.
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^## Protocol ${version.replace(/[.]/g, '\\.')}( — \\d{4}-\\d{2}-\\d{2})?$`);
  return sectionByHeading(lines, (line) => heading.test(line));
}

export function unreleasedSection(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return sectionByHeading(lines, (line) => line === UNRELEASED_HEADING);
}

function sectionByHeading(lines, matches) {
  const starts = lines.flatMap((line, index) => (matches(line) ? [index] : []));
  if (starts.length !== 1) return { count: starts.length, body: '' };
  const start = starts[0] + 1;
  let end = lines.findIndex((line, index) => index >= start && line.startsWith('## '));
  if (end === -1) end = lines.length;
  return { count: 1, body: lines.slice(start, end).join('\n').trim() };
}

// The CHANGELOG edit of a release PR: the unreleased section becomes
// `## Protocol <version> — <date>`, and an empty unreleased heading goes above.
export function cutChangelog(text, version, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`invalid date ${date}`);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const index = lines.indexOf(UNRELEASED_HEADING);
  if (index === -1 || lines.indexOf(UNRELEASED_HEADING, index + 1) !== -1) {
    throw new Error(`${CHANGELOG} must have exactly one "${UNRELEASED_HEADING}" heading`);
  }
  if (changelogSection(text, version).count !== 0) {
    throw new Error(`${CHANGELOG} already has a section for ${version}`);
  }
  lines.splice(index, 1, UNRELEASED_HEADING, '', `## Protocol ${version} — ${date}`);
  return lines.join(eol);
}

// The platforms of a release, in this order wherever they are listed. A tag
// run drafts the release from DRAFT_PLATFORMS; macOS joins the same release
// when its build finishes (#164), because macOS runners can take up to a day.
export const PLATFORMS = ['windows', 'macos', 'linux'];
export const DRAFT_PLATFORMS = ['windows', 'linux'];
export const LATE_PLATFORM = 'macos';

// `windows,linux` -> ['windows', 'linux'] in PLATFORMS order; throws on an
// unknown, repeated or missing name.
export function parsePlatforms(text) {
  const names = String(text ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  for (const name of names) if (!PLATFORMS.includes(name)) throw new Error(`unknown platform ${name}`);
  if (names.length === 0 || new Set(names).size !== names.length) throw new Error(`invalid platform list "${text}"`);
  return PLATFORMS.filter((name) => names.includes(name));
}

// Release asset names. Versionless where people link to them
// (/releases/latest/download/<name>), Debian's name_version_arch for the deb.
export function releaseAssets(version) {
  return {
    windows: ['protocol-windows-x64-setup.exe'],
    macos: ['protocol-macos-arm64.dmg', 'protocol-macos-arm64.app.tar.gz'],
    linux: ['protocol-linux-x86_64.AppImage', `protocol_${version}_amd64.deb`],
  };
}

// The file the updater installs on each platform; each gets a `.sig` from the
// production key.
export const PLATFORM_PAYLOADS = {
  windows: 'protocol-windows-x64-setup.exe',
  macos: 'protocol-macos-arm64.app.tar.gz',
  linux: 'protocol-linux-x86_64.AppImage',
};
export const UPDATER_PAYLOADS = PLATFORMS.map((platform) => PLATFORM_PAYLOADS[platform]);

// A platform's own assets: its packages and its payload's signature, sorted.
export function platformAssets(version, platform) {
  return [...releaseAssets(version)[platform], `${PLATFORM_PAYLOADS[platform]}.sig`].sort();
}

// Every asset of a release that has `platforms`, sorted. latest.json and
// SHA256SUMS.txt always cover exactly the platforms the release has.
export function requiredAssets(version, platforms = PLATFORMS) {
  return [...platforms.flatMap((platform) => platformAssets(version, platform)), 'latest.json', 'SHA256SUMS.txt'].sort();
}

// The platforms whose assets `names` holds, as { platforms, problems }. A
// platform with only some of its assets is a problem: a release never shows
// a macOS download without its updater bundle, or the reverse.
export function platformsOf(names, version) {
  const platforms = [];
  const problems = [];
  for (const platform of PLATFORMS) {
    const assets = platformAssets(version, platform);
    const present = assets.filter((name) => names.includes(name));
    if (present.length === assets.length) platforms.push(platform);
    else if (present.length > 0) problems.push(`${platform} is incomplete: ${assets.filter((name) => !present.includes(name)).join(', ')} missing`);
  }
  return { platforms, problems };
}

// tauri-plugin-updater looks up `{os}-{arch}-{installer}` first, then
// `{os}-{arch}`. The generic keys cover executables without a bundle-type
// marker; Linux has no generic key, so a .deb install (marker "deb") finds no
// entry and #31 shows a download link instead of installing an AppImage. A
// release without macOS yet has no darwin keys: macOS installs report "not
// available for macOS yet" (noPlatform) and are offered the release once
// macOS joins it.
export const FEED_PLATFORMS = {
  'windows-x86_64-nsis': 'protocol-windows-x64-setup.exe',
  'windows-x86_64': 'protocol-windows-x64-setup.exe',
  'darwin-aarch64-app': 'protocol-macos-arm64.app.tar.gz',
  'darwin-aarch64': 'protocol-macos-arm64.app.tar.gz',
  'linux-x86_64-appimage': 'protocol-linux-x86_64.AppImage',
};

// The feed keys of `platforms`, in FEED_PLATFORMS order.
export function feedKeys(platforms) {
  const payloads = platforms.map((platform) => PLATFORM_PAYLOADS[platform]);
  return Object.keys(FEED_PLATFORMS).filter((key) => payloads.includes(FEED_PLATFORMS[key]));
}

export function assetUrl(version, name, repository = REPOSITORY) {
  return `https://github.com/${repository}/releases/download/v${version}/${name}`;
}

// Cuts Markdown notes at a paragraph or list-item boundary so they fit in
// `limit` bytes together with a link to the full notes.
export function feedNotes(notes, version, limit = FEED_NOTES_LIMIT, repository = REPOSITORY) {
  if (Buffer.byteLength(notes) <= limit) return notes;
  const more = `\n\n[Full release notes](https://github.com/${repository}/releases/tag/v${version})`;
  const budget = limit - Buffer.byteLength(more);
  let cut = notes;
  while (Buffer.byteLength(cut) > budget) {
    const boundary = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n- '));
    cut = boundary > 0 ? cut.slice(0, boundary) : prefixWithinBytes(cut, budget);
  }
  return cut.trimEnd() + more;
}

// The longest prefix of `text` within `budget` UTF-8 bytes that ends between
// code points. A cut inside a surrogate pair would leave a lone surrogate,
// which JSON.stringify writes as \udXXX and the updater's serde_json rejects,
// making the whole feed unreadable.
function prefixWithinBytes(text, budget) {
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    bytes += Buffer.byteLength(codePoint);
    if (bytes > budget) break;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

// latest.json for tauri-plugin-updater. `signatures` maps each updater payload
// to the content of its .sig file (base64 text, as Tauri writes it). A missing
// payload of one of `platforms` is an error: every platform the release has
// needs its full set of feed keys.
export function latestJson({ version, notes, pubDate, signatures, platforms: releasePlatforms = PLATFORMS, repository = REPOSITORY }) {
  if (!parseVersion(version)) throw new Error(`invalid version ${version}`);
  if (Number.isNaN(Date.parse(pubDate))) throw new Error(`invalid pub_date ${pubDate}`);
  const platforms = {};
  for (const platform of feedKeys(releasePlatforms)) {
    const asset = FEED_PLATFORMS[platform];
    const signature = signatures[asset]?.trim();
    if (!signature) throw new Error(`no signature for ${asset}`);
    platforms[platform] = { signature, url: assetUrl(version, asset, repository) };
  }
  return { version, notes: feedNotes(notes, version, FEED_NOTES_LIMIT, repository), pub_date: pubDate, platforms };
}

export async function sha256File(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

// GNU sha256sum format: `<hex>  <name>`, sorted by name, LF, trailing newline.
export function formatSha256Sums(entries) {
  return [...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(({ hash, name }) => `${hash}  ${name}\n`)
    .join('');
}

export function parseSha256Sums(text) {
  return text.split('\n').filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line}`);
    return { hash: match[1], name: match[2] };
  });
}

// GitHub renders each newline of a release body as a line break, so text
// wrapped for the source (the CHANGELOG and the notes template) would show
// its wraps. Joins the lines of every paragraph and list item; blank lines,
// headings, list markers, tables, quotes, HTML, code blocks and hard breaks
// (two trailing spaces or a backslash) stay as they are.
export function unwrapMarkdown(text) {
  const lines = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    const fence = /^\s*```/.test(line);
    const previous = lines.at(-1);
    if (!inFence && !fence && joinsPrevious(previous, line)) {
      lines[lines.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    } else {
      lines.push(line);
    }
    if (fence) inFence = !inFence;
  }
  return lines.join('\n');
}

function joinsPrevious(previous, line) {
  if (previous === undefined || previous.trim() === '' || line.trim() === '') return false;
  if (/^\s*([-*+]\s|\d+[.)]\s|#|\||>|<)/.test(line)) return false;
  return !/^\s*(#|\||```)/.test(previous) && !/( {2}|\\)$/.test(previous);
}
