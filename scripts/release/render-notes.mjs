#!/usr/bin/env node
// The GitHub release body: the CHANGELOG section plus the fixed download,
// install, update and verification text.
//
//   node scripts/release/render-notes.mjs --version 0.3.0 --notes <file> --sums <SHA256SUMS.txt> [--first-release] [--attestations] > notes.md
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPOSITORY, assetUrl, releaseAssets } from './release-lib.mjs';

export function renderNotes({ version, notes, sums, firstRelease = false, attestations = false, repository = REPOSITORY }) {
  const assets = releaseAssets(version);
  const link = (name) => `[${name}](${assetUrl(version, name, repository)})`;
  const [windows] = assets.windows;
  const [dmg] = assets.macos;
  const [appImage, deb] = assets.linux;
  return `Protocol is a local-first meeting recorder and transcriber, forked from
[Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree).${firstRelease ? ' This is its first release.' : ''}

## What's new

${notes.trim()}

## Download

| Platform | File | Notes |
| --- | --- | --- |
| Windows 10/11 x64 | ${link(windows)} | Picks the Vulkan (GPU) or CPU build automatically |
| macOS 14.2+ (Apple Silicon) | ${link(dmg)} | |
| Linux x64 — **experimental** | ${link(appImage)} or ${link(deb)} | Built in CI, not tested on real hardware |

The \`.app.tar.gz\` and \`.sig\` files and \`latest.json\` are used by Protocol's built-in updater; you don't need to
download them.

## Install

These builds are **not code-signed** (there is no Windows or Apple certificate yet), so your system warns you the
first time.

**Windows.** Run \`${windows}\`. If Microsoft Defender SmartScreen shows "Windows protected your PC", click
**More info**, then **Run anyway**. Setup installs for your user only (no administrator rights) into
\`%LOCALAPPDATA%\\vmedvedevpro\\Protocol\`, installs the Microsoft Visual C++ runtime and WebView2 if they are missing,
and chooses the Vulkan GPU build when your graphics driver supports it, otherwise the CPU build. NVIDIA CUDA is not
included; NVIDIA GPUs use Vulkan.

**macOS.** Open the DMG and drag Protocol to Applications. The first time you open it, macOS says it cannot verify
that Protocol is free of malware. Click **Done**, open **System Settings → Privacy & Security**, scroll to the message
about Protocol and click **Open Anyway**, then confirm. You only do this once. (Terminal alternative:
\`xattr -dr com.apple.quarantine /Applications/Protocol.app\`.) Allow microphone and system-audio access when asked.

**Linux (experimental).** AppImage: \`chmod +x ${appImage} && ./${appImage}\`
(Ubuntu 22.04 needs \`libfuse2\`, 24.04 \`libfuse2t64\`). Debian/Ubuntu package:
\`sudo apt install ./${deb}\`. Linux builds compile and start in CI but have not been tested with real
meetings; system-audio capture may not work on your desktop. Reports are welcome.

## Updates

Protocol checks this page for a newer release once a day. When there is one, it tells you, and the update downloads
only when you click **Download**. Protocol verifies the download's signature and installs it when you click
**Restart and update** or quit the app — never during a recording. Turn automatic checks off in Settings › About.
The \`.deb\` package does not update itself; install the new package from this page.

## Verify your download

Download \`SHA256SUMS.txt\` next to the file, then:

- Linux: \`sha256sum -c SHA256SUMS.txt --ignore-missing\`
- macOS: \`shasum -a 256 -c SHA256SUMS.txt --ignore-missing\`
- Windows (PowerShell): \`(Get-FileHash .\\${windows} -Algorithm SHA256).Hash\` and compare with the line in
  \`SHA256SUMS.txt\`
${attestations ? `
Each installer and updater file also has a build-provenance attestation that ties it to this repository's release
workflow and commit: \`gh attestation verify <file> -R ${repository}\`.
` : ''}
\`\`\`
${sums.trim()}
\`\`\`

## Notes

- Protocol runs beside an installed Meetily or Meetily – Actually Free and does not share their data or settings.
- If Protocol closes as soon as it starts transcribing with a Whisper model, your graphics driver's Vulkan support is
  the likely cause. Run \`${windows} /BACKEND=cpu\` from a terminal; Protocol then stays on the CPU build, including
  after updates (\`/BACKEND=auto\` returns to the automatic choice).

**Full changelog:** [CHANGELOG.md](https://github.com/${repository}/blob/v${version}/CHANGELOG.md)
`;
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  if (!option('version') || !option('notes') || !option('sums')) {
    console.error('usage: render-notes.mjs --version <v> --notes <file> --sums <file> [--first-release] [--attestations]');
    process.exit(2);
  }
  process.stdout.write(renderNotes({
    version: option('version'),
    notes: readFileSync(option('notes'), 'utf8'),
    sums: readFileSync(option('sums'), 'utf8'),
    firstRelease: args.includes('--first-release'),
    attestations: args.includes('--attestations'),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
