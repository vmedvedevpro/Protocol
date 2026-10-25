# Protocol

A local-first meeting recorder and transcriber for Windows.

Protocol records the microphone and computer audio of a call, transcribes it on
the machine, labels who spoke, and keeps notes, action items, and summaries next
to the transcript. It is a personal fork of
[Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree),
tuned for the calls I record: mostly in Russian, often on Discord, on a laptop
with an Intel Arc GPU (Vulkan, no CUDA).

> **Status:** early fork. There are no Protocol releases yet; build from source.
> Planned work is tracked in [issues](https://github.com/vmedvedevpro/Protocol/issues).

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
  key (Claude, OpenAI, Groq, OpenRouter, a custom endpoint, or the Claude Code CLI).
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
- **No updater.** There is no in-app updater and no update check. To update,
  pull the source and rebuild.

## Roadmap

| Area | Issues |
| --- | --- |
| Hygiene and security | [#1](https://github.com/vmedvedevpro/Protocol/issues/1) model hashes, [#2](https://github.com/vmedvedevpro/Protocol/issues/2) Claude CLI, [#3](https://github.com/vmedvedevpro/Protocol/issues/3) IPC commands, [#4](https://github.com/vmedvedevpro/Protocol/issues/4) diagnostics script |
| Russian transcription | [#5](https://github.com/vmedvedevpro/Protocol/issues/5) GigaAM v3 |
| Starting recordings | [#6](https://github.com/vmedvedevpro/Protocol/issues/6) Discord detection, [#7](https://github.com/vmedvedevpro/Protocol/issues/7) Google Calendar via iCal |
| Using meetings elsewhere | [#8](https://github.com/vmedvedevpro/Protocol/issues/8) read-only MCP server |
| Optional | [#9](https://github.com/vmedvedevpro/Protocol/issues/9) labels by device, [#10](https://github.com/vmedvedevpro/Protocol/issues/10) local-network-only mode, [#11](https://github.com/vmedvedevpro/Protocol/issues/11) archive encryption |
| Fork cleanup | [#12](https://github.com/vmedvedevpro/Protocol/issues/12) executable name, [#13](https://github.com/vmedvedevpro/Protocol/issues/13) icon, [#14](https://github.com/vmedvedevpro/Protocol/issues/14) dead analytics, [#15](https://github.com/vmedvedevpro/Protocol/issues/15) CI, [#16](https://github.com/vmedvedevpro/Protocol/issues/16) upstream docs |

## Privacy

Recordings, transcripts, and settings stay on the machine. Nothing is sent
anywhere unless you choose a cloud provider or the Claude Code CLI for
summaries, which then processes that content under its own terms. Analytics
transmission is disabled and there are no update checks. The network is used to
download models: most come from Hugging Face, while the speaker models and a
Parakeet fallback still come from upstream's GitHub releases
([#1](https://github.com/vmedvedevpro/Protocol/issues/1)). See
[PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Where data lives

| Data | Windows location |
| --- | --- |
| Database, templates, models, file-backed settings | `<app folder>\data` (installed: `%LOCALAPPDATA%\vmedvedevpro\Protocol\data`; dev build: `target\debug\data`); `%APPDATA%\vmedvedevpro\Protocol` if that folder is not writable |
| Recording and onboarding preferences | `%APPDATA%\io.github.vmedvedevpro.protocol` |
| WebView storage | `%LOCALAPPDATA%\io.github.vmedvedevpro.protocol` |
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

The universal Windows installer (CPU, Vulkan, and CUDA variants; needs the CUDA
toolkit) is built and checked with:

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
