<p align="center">
  <img src="frontend/src-tauri/icon-source.png" alt="Protocol logo" width="120" />
</p>

<h1 align="center">Protocol</h1>

<p align="center">
  <strong>Meeting notes that never leave your computer.</strong><br>
  Protocol records your calls, transcribes them on your machine, tells the
  speakers apart, and keeps notes, action items, and summaries next to the
  transcript.
</p>

<p align="center">
  <a href="https://github.com/vmedvedevpro/Protocol/releases/latest/download/protocol-windows-x64-setup.exe"><strong>Download for Windows</strong></a>
  · <a href="https://github.com/vmedvedevpro/Protocol/releases/latest/download/protocol-macos-arm64.dmg">macOS (Apple Silicon)</a>
  · <a href="https://github.com/vmedvedevpro/Protocol/releases/latest">Linux (experimental)</a>
  · <a href="https://github.com/vmedvedevpro/Protocol/releases/latest">Release notes</a>
</p>

Free and open source: no account, no subscription, no analytics. Protocol is
built on [Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree),
which in turn builds on the original [Meetily](https://github.com/Zackriya-Solutions/meetily).

## Why Protocol

Protocol keeps everything Meetily – Actually Free offers (speaker
diarization, voice profiles, Labs, every AI provider, no paid tier) and adds
what an app that hears all your calls should have:

- **Runs next to Meetily.** Its own name, `protocol.exe`, folders, and
  settings. Install it beside Meetily or Meetily – Actually Free and keep
  both: installing, updating, or removing Protocol leaves them running and
  their data untouched.
- **Updates you control.** One check a day, which you can turn off. An update
  downloads only when you click **Download**, its signature is verified, and it
  installs when you click **Restart and update** or quit the app, never during
  a recording or while a meeting is being processed.
- **Models you can trust.** Whisper, Parakeet, the summary models, and the
  speaker models are downloaded from pinned sources (an exact Hugging Face
  commit or this repository's release), and every file is checked against a
  known SHA-256 before Protocol loads it.
- **Less that can go wrong.** No analytics code, no support script that zipped
  your database with its API keys, and 70 unused internal commands removed,
  seven of which let the app's web view read any file or send transcripts to
  any server. No setting starts an executable of your choice.
- **One small Windows installer.** About 118 MB. It picks the Vulkan GPU build
  (NVIDIA, AMD, Intel Arc) or the CPU build for your computer by itself.
- **Builds you can check.** Windows, macOS, and Linux builds come from public
  GitHub Actions runs, with `SHA256SUMS.txt` and build-provenance
  attestations.

| | Protocol | Meetily – Actually Free 0.2.22 |
| --- | --- | --- |
| Speaker diarization, voice profiles, Labs | ✅ | ✅ |
| No account, licence key, or paid tier | ✅ | ✅ |
| Installs beside another Meetily | ✅ own name and folders | ❌ same `meetily.exe` as Meetily |
| Model downloads | Every model from a pinned source, checked by SHA-256 | Several from moving branches, checked by size or not at all |
| Analytics code | None | Inactive PostHog SDK |
| Unused internal commands | Removed | 70, seven of them with unchecked paths or URLs |
| Platforms | Windows, macOS (Apple Silicon), Linux (experimental) | Windows, macOS preview |

Meetily itself has a free Community Edition and a paid PRO tier; Meetily –
Actually Free unlocks the app's features without a paid tier, and Protocol
builds on that.

## Features

- **Capture.** Microphone and computer audio are recorded as separate tracks
  plus a mixed track. On Windows you can capture only the apps you choose
  instead of all computer audio.
- **Transcription on your machine.** Live transcription with Parakeet, and
  optional Whisper for a more accurate pass after the call. Import existing
  audio files too.
- **Who said what.** Your microphone is always **You**; remote voices are told
  apart with Pyannote/WeSpeaker or the optional Nemotron model. Rename and
  merge speakers during or after a call, link them to contacts, and let
  Protocol suggest names it has heard before (voice profiles, beta).
- **Notes and summaries.** Notes, action items, and AI summaries with local
  models (built-in models or Ollama) or a provider you connect with your own
  key: Claude, OpenAI, Groq, OpenRouter, or any compatible endpoint. Ask
  questions about a meeting and use your own summary templates.
- **Your meeting library.** History, groups, contacts, a **Ctrl+K** command
  bar, and export to PDF, Word, Markdown (with YAML frontmatter), text, or
  JSON.
- **Labs.** Opt-in meeting detection and automatic recording, waveform
  scrubbing, clean transcripts, a Whisper silence guard, and Parakeet on the
  GPU through DirectML.

## Install

Download the file for your system from the
[latest release](https://github.com/vmedvedevpro/Protocol/releases/latest):

| System | Download |
| --- | --- |
| Windows 10/11 x64 | [protocol-windows-x64-setup.exe](https://github.com/vmedvedevpro/Protocol/releases/latest/download/protocol-windows-x64-setup.exe) |
| macOS 14.2+ on Apple Silicon | [protocol-macos-arm64.dmg](https://github.com/vmedvedevpro/Protocol/releases/latest/download/protocol-macos-arm64.dmg) |
| Linux x64 (experimental) | [protocol-linux-x86_64.AppImage](https://github.com/vmedvedevpro/Protocol/releases/latest/download/protocol-linux-x86_64.AppImage), or `protocol_<version>_amd64.deb` from the release page |

The builds are not code-signed yet, so your system warns you the first time.
The [release notes](https://github.com/vmedvedevpro/Protocol/releases/latest)
have the details and the checksums.

- **Windows:** if SmartScreen says "Windows protected your PC", click
  **More info**, then **Run anyway**. Setup installs for your user only, with
  no administrator rights.
- **macOS:** if Gatekeeper cannot verify Protocol, click **Open Anyway** in
  **System Settings → Privacy & Security** once.
- **Linux** builds are experimental: they are built and started in CI but not
  yet tested with real meetings.

After that, Protocol offers new versions itself; see
[docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md) for how updates work.

## Privacy

Recordings, transcripts, and settings stay on your computer. Nothing is sent
anywhere unless you choose a cloud provider for summaries, which then
processes that content under its own terms. Once a day, unless you turn it
off, Protocol asks GitHub whether a newer release exists; the request carries
nothing about you or your meetings. Models are downloaded from Hugging Face at
pinned commits, and the repair download of the bundled speaker models from this
repository. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

<details>
<summary><strong>Where your data lives</strong></summary>

| Data | Windows location |
| --- | --- |
| Database, templates, models, file-backed settings | `<app folder>\data` (installed: `%LOCALAPPDATA%\vmedvedevpro\Protocol\data`; dev build: `target\debug\data`); `%APPDATA%\vmedvedevpro\Protocol` if that folder is not writable |
| Recording and onboarding preferences | `%APPDATA%\io.github.vmedvedevpro.protocol` |
| WebView storage | `%LOCALAPPDATA%\io.github.vmedvedevpro.protocol` |
| Downloaded update and `updater.log` | `%LOCALAPPDATA%\io.github.vmedvedevpro.protocol\updates` (update preferences: `updater.json` in `%APPDATA%\io.github.vmedvedevpro.protocol`) |
| Recordings | `Music\protocol-recordings` (change in **Settings → Recording**) |

On macOS the first row is `~/Library/Application Support/vmedvedevpro/Protocol` and
recordings default to `~/Movies/protocol-recordings`.

</details>

## What's next

| Area | Issues |
| --- | --- |
| Russian transcription | [#5](https://github.com/vmedvedevpro/Protocol/issues/5) GigaAM v3 |
| Starting recordings | [#6](https://github.com/vmedvedevpro/Protocol/issues/6) Discord call detection, [#7](https://github.com/vmedvedevpro/Protocol/issues/7) Google Calendar via iCal |
| Recording reliability | [#28](https://github.com/vmedvedevpro/Protocol/issues/28) reconnect a disconnected audio device, [#32](https://github.com/vmedvedevpro/Protocol/issues/32) confirm before quitting during a recording |
| Using meetings elsewhere | [#8](https://github.com/vmedvedevpro/Protocol/issues/8) read-only MCP server |
| Speaker labels | [#23](https://github.com/vmedvedevpro/Protocol/issues/23) public ONNX exports of the diarization models |
| Hygiene and security | [#3](https://github.com/vmedvedevpro/Protocol/issues/3) IPC commands |
| Optional | [#9](https://github.com/vmedvedevpro/Protocol/issues/9) labels by device, [#10](https://github.com/vmedvedevpro/Protocol/issues/10) local-network-only mode, [#11](https://github.com/vmedvedevpro/Protocol/issues/11) archive encryption |
| Project | [#16](https://github.com/vmedvedevpro/Protocol/issues/16) upstream docs, [#17](https://github.com/vmedvedevpro/Protocol/issues/17) README badges |

Found a bug or want something? [Open an issue](https://github.com/vmedvedevpro/Protocol/issues).

## For developers

Building from source, checks, releases, and syncing with upstream are in
[docs/BUILDING.md](docs/BUILDING.md). Start with [AGENTS.md](AGENTS.md),
[ARCHITECTURE.md](ARCHITECTURE.md), and the
[development map](docs/DEVELOPMENT_MAP.md) before changing code.

## Credits and license

Protocol is based on [Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree)
by Tyler Buza and the original [Meetily](https://github.com/Zackriya-Solutions/meetily)
by Zackriya Solutions, with contributions from their communities.

MIT licensed; see [LICENSE.md](LICENSE.md). Upstream copyright notices are retained.
