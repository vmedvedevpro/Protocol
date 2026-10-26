# Protocol

A local-first meeting recorder and transcriber for Windows.

Protocol records the microphone and computer audio of a call, transcribes it on
the machine, labels who spoke, and keeps notes, action items, and summaries next
to the transcript. It is a personal fork of
[Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree),
tuned for the calls I record: mostly in Russian, often on Discord, on a laptop
with an Intel Arc GPU (Vulkan, no CUDA).

> **Status:** early fork. Planned work is tracked in
> [issues](https://github.com/vmedvedevpro/Protocol/issues).

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
  **More info**, then **Run anyway**.
- **macOS:** if Gatekeeper cannot verify Protocol, click **Open Anyway** in
  **System Settings → Privacy & Security** once.
- **Linux** builds are experimental: they are built and started in CI but not
  tested with real meetings.

After that, Protocol offers new versions itself (see below). To build it
yourself, see [Build from source](#build-from-source-windows).

## What it does

Everything below comes from upstream and works as it does there.

- **Capture.** Microphone and computer audio are recorded as separate tracks
  (`mic.mp4`, `system.mp4`) plus a mixed `audio.mp4`. On Windows you can capture
  selected applications instead of all computer audio.
- **Transcription.** Live transcription with Parakeet; optional Whisper for
  post-call enhancement. Whisper runs on Vulkan, CUDA, or CPU depending on the
  build.
- **Speakers.** Your microphone is always labeled **You**; remote voices are
  separated with Pyannote/WeSpeaker or the optional Nemotron model. Rename and
  merge speakers during or after a call; link them to contacts.
- **Notes and summaries.** Notes, action items, and AI summaries with local
  models (built-in GGUF models, Ollama) or a provider you configure with your own
  key (Claude, OpenAI, Groq, OpenRouter, or a custom endpoint).
- **Library.** Meeting history, groups, contacts, a Ctrl+K command bar, and export
  to PDF, Word, Markdown (with YAML frontmatter), text, or JSON.
- **Labs.** Opt-in meeting detection and automation, waveform scrubbing, clean
  transcripts, a Whisper silence guard, Parakeet on DirectML, and voice profiles.

## How it differs from upstream

- **Own identity.** Product name, bundle identifier
  (`io.github.vmedvedevpro.protocol`), install folder, data folders, recordings
  folder, and Windows notification identity are all separate, so Protocol runs
  beside an installed Meetily or Meetily – Actually Free without sharing data,
  settings, or the single-instance lock. The executable is `protocol.exe`, so
  installing, upgrading, or uninstalling Protocol leaves a running Meetily
  alone, with one exception: the first upgrade over a Protocol build that still
  has `meetily.exe` can run that build's old uninstaller, which closes every
  running `meetily.exe`. Close Meetily too before that upgrade (see
  [ARCHITECTURE.md](ARCHITECTURE.md#8-windows-installer-and-onboarding)).
  Setup and uninstall still close any other running `protocol.exe` of your
  user, such as a dev build or a Labs install: they ask first in an
  interactive run and close it without asking in passive and silent runs.
- **Updates from GitHub releases, on your click.** Once a day Protocol asks
  this repository's releases whether a newer version exists and, if so, shows
  **Update available** with the release notes. It downloads the update only
  when you click **Download**, verifies its signature, and installs it when you
  click **Restart and update** or quit the app, never during a recording. Turn
  the daily check off in Settings › About; the `.deb` package shows a link
  instead of updating itself. See [docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md).
- **No Claude Code CLI provider.** No IPC command runs an executable you chose
  any more; Built-in AI still starts its bundled `llama-helper`, and the Ollama
  check may run `ollama list`. A summary provider saved as the CLI loads as
  unselected, and the app asks you to choose another
  ([#19](https://github.com/vmedvedevpro/Protocol/issues/19)).

## Roadmap

| Area | Issues |
| --- | --- |
| Hygiene and security | [#3](https://github.com/vmedvedevpro/Protocol/issues/3) IPC commands |
| Russian transcription | [#5](https://github.com/vmedvedevpro/Protocol/issues/5) GigaAM v3 |
| Starting recordings | [#6](https://github.com/vmedvedevpro/Protocol/issues/6) Discord detection, [#7](https://github.com/vmedvedevpro/Protocol/issues/7) Google Calendar via iCal |
| Using meetings elsewhere | [#8](https://github.com/vmedvedevpro/Protocol/issues/8) read-only MCP server |
| Optional | [#9](https://github.com/vmedvedevpro/Protocol/issues/9) labels by device, [#10](https://github.com/vmedvedevpro/Protocol/issues/10) local-network-only mode, [#11](https://github.com/vmedvedevpro/Protocol/issues/11) archive encryption |
| Fork cleanup | [#16](https://github.com/vmedvedevpro/Protocol/issues/16) upstream docs |

## Privacy

Recordings, transcripts, and settings stay on the machine. Nothing is sent
anywhere unless you choose a cloud provider for summaries, which then
processes that content under its own terms. Analytics have been removed. Once
a day, unless you turn it off, Protocol asks GitHub whether a newer release
exists; the request carries nothing about you or your meetings, and an update
downloads only when you click **Download**. The network is also used to
download models: from Hugging Face at
pinned commits, and the repair download of the bundled speaker models from this
repository. Every downloaded file is checked against a pinned SHA-256. See
[PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Where data lives

| Data | Windows location |
| --- | --- |
| Database, templates, models, file-backed settings | `<app folder>\data` (installed: `%LOCALAPPDATA%\vmedvedevpro\Protocol\data`; dev build: `target\debug\data`); `%APPDATA%\vmedvedevpro\Protocol` if that folder is not writable |
| Recording and onboarding preferences | `%APPDATA%\io.github.vmedvedevpro.protocol` |
| WebView storage | `%LOCALAPPDATA%\io.github.vmedvedevpro.protocol` |
| Downloaded update and `updater.log` | `%LOCALAPPDATA%\io.github.vmedvedevpro.protocol\updates` (update preferences: `updater.json` in `%APPDATA%\io.github.vmedvedevpro.protocol`) |
| Recordings | `Music\protocol-recordings` (change in **Settings → Recording**) |

On macOS the first row is `~/Library/Application Support/vmedvedevpro/Protocol` and
recordings default to `~/Movies/protocol-recordings`.

## Build from source (Windows)

Prerequisites: Rust (MSVC toolchain), Node.js 20+ with pnpm, Visual Studio 2022
Build Tools with C++, CMake, LLVM/libclang (18 recommended), and the Vulkan SDK
for a Vulkan build.

```powershell
cd frontend
pnpm install
pnpm run tauri:dev:vulkan   # or tauri:dev:cpu / tauri:dev:cuda
```

Frontend checks, as run in CI:

```powershell
cd frontend
pnpm dlx bun@1.3.10 scripts/test-isolated.mjs
pnpm run build
pnpm exec tsc --noEmit
```

Releases are built in GitHub Actions (see
[WORKFLOWS_OVERVIEW.md](.github/workflows/WORKFLOWS_OVERVIEW.md)). The same
Windows installer (CPU and Vulkan builds) can be built and checked locally with:

```powershell
cd frontend
.\scripts\build-universal-windows.ps1 -AllowUnsigned
node scripts\verify-windows-release.mjs
```

Before changing code, read [AGENTS.md](AGENTS.md),
[ARCHITECTURE.md](ARCHITECTURE.md), and the
[development map](docs/DEVELOPMENT_MAP.md). Most notes under `docs/` are
upstream's engineering and release history.

## Staying in sync with upstream

Internal names (the `meetily` crate, `MEETILY_*` environment variables, storage
keys) are kept as upstream has them so merges stay small.

```powershell
git remote add upstream https://github.com/TylerBuza/Meetily-ActuallyFree.git
git fetch upstream
git merge upstream/main
```

## Credits and license

Protocol is based on [Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree)
by Tyler Buza and the original [Meetily](https://github.com/Zackriya-Solutions/meetily)
by Zackriya Solutions, with contributions from their communities.

MIT licensed; see [LICENSE.md](LICENSE.md). Upstream copyright notices are retained.
