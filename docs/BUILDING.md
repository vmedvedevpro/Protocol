# Building and contributing

How to build Protocol from source, check a change, and keep the fork in sync with
upstream. For what the app does and how to install a release, see the
[README](../README.md).

Before changing code, read [AGENTS.md](../AGENTS.md),
[ARCHITECTURE.md](../ARCHITECTURE.md), and the
[development map](DEVELOPMENT_MAP.md). Most other notes under `docs/` are
upstream's engineering notes; its release notes are in
[docs/upstream/](upstream/README.md).

## Build from source (Windows)

Prerequisites: Rust (MSVC toolchain), Node.js 20+ with pnpm, Visual Studio 2022
Build Tools with C++, CMake, LLVM/libclang (18 recommended), and the Vulkan SDK
for a Vulkan build.

```powershell
cd frontend
pnpm install
pnpm run tauri:dev:vulkan   # or tauri:dev:cpu / tauri:dev:cuda
```

A Vulkan build needs a short cargo target dir. whisper.cpp builds its Vulkan
shader generator as a nested CMake project deep inside the target dir, and the
compiler cannot write paths longer than Windows' 259 characters, even with long
paths enabled. The limit is 31 characters with Ninja on `PATH` and 22 with
CMake's default Visual Studio generator, so the default `target` of a checkout
under your user folder is too long:

```powershell
$env:CARGO_TARGET_DIR = 'C:\t'
```

`build-universal-windows.ps1` checks this before it builds. CPU builds have no
such limit.

A clean build downloads and verifies what the speech models run on, so it
needs network access:

- ONNX Runtime 1.24.4 (`build/onnxruntime.rs`, exact sizes and SHA-256): on
  Windows Microsoft's DirectML NuGet packages, on Linux x64 Microsoft's
  `onnxruntime-linux-x64-1.24.4` release archive. The app loads it from
  `binaries/onnxruntime/` (the installer's, deb's or AppImage's resources),
  never from `PATH` or the system library path. macOS builds link the runtime
  `ort` downloads instead.
  - Only `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` have a pinned
    runtime; the build script stops with an error for any other Windows or
    Linux target (Linux aarch64 or musl, for example).
  - Both stage into the same `frontend/src-tauri/binaries/onnxruntime/`, so
    building one checkout for Windows and for Linux (from WSL, say) replaces
    the other's files, and each build downloads its runtime again.
- The Silero VAD model (`vendor/silero-rs/build.rs`), embedded into the app.

Frontend checks, as run in CI:

```powershell
cd frontend
pnpm dlx bun@1.3.10 scripts/test-isolated.mjs
pnpm run build
pnpm exec tsc --noEmit
```

## Releases

Releases are built in GitHub Actions from a pushed `vX.Y.Z` tag into a draft
that the owner publishes; the procedure is in
[WORKFLOWS_OVERVIEW.md](../.github/workflows/WORKFLOWS_OVERVIEW.md), and the
updater's feed and signing rules in [AUTO_UPDATE.md](AUTO_UPDATE.md). The same
Windows installer (CPU and Vulkan builds) can be built and checked locally with:

```powershell
cd frontend
.\scripts\build-universal-windows.ps1 -AllowUnsigned
node scripts\verify-windows-release.mjs
```

## Staying in sync with upstream

Protocol merges
[Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree)
through the `upstream` remote. Internal names (`MEETILY_*` environment
variables, storage and event keys) are kept as upstream has them so merges stay
small; the Cargo package and the executable are `protocol`.

Upstream's tags include Meetily's own `v0.3.0` and `v0.4.0`, which would collide
with Protocol's release tags, so the remote is set up without tags:

```powershell
git remote add upstream https://github.com/TylerBuza/Meetily-ActuallyFree.git
git config remote.upstream.tagOpt --no-tags
git fetch upstream
git merge upstream/main
```
