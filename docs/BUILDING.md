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

The app bundles two programs built from this workspace, and Tauri stops
before building when `frontend/src-tauri/binaries/` lacks either one (named
with the target triple, as `externalBin` in `tauri.conf.json` expects):
`llama-helper` (the built-in summary model) and `protocol-mcp` (the
[MCP server](MCP_SERVER.md) for AI agents). Build and copy them once, and
again after changing them:

```powershell
cargo build --release -p llama-helper -p protocol-mcp
Copy-Item "$env:CARGO_TARGET_DIR\release\llama-helper.exe" frontend\src-tauri\binaries\llama-helper-x86_64-pc-windows-msvc.exe
Copy-Item "$env:CARGO_TARGET_DIR\release\protocol-mcp.exe" frontend\src-tauri\binaries\protocol-mcp-x86_64-pc-windows-msvc.exe
```

(Without `CARGO_TARGET_DIR` set, the files are in `target\release`.)

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
  Windows Microsoft's DirectML NuGet packages, on Linux x64 the linux-x64
  library of Microsoft's `Microsoft.ML.OnnxRuntime` NuGet package. The app
  loads it from `binaries/onnxruntime/` (the installer's, deb's or AppImage's
  resources), never from `PATH` or the system library path. macOS builds link
  the runtime `ort` downloads instead.
  - Only `x86_64-pc-windows-msvc` and `x86_64-unknown-linux-gnu` have a pinned
    runtime; the build script stops with an error for any other Windows or
    Linux target (Linux aarch64 or musl, for example).
  - Both stage into the same `frontend/src-tauri/binaries/onnxruntime/`, so
    building one checkout for Windows and for Linux (from WSL, say) replaces
    the other's files, and each build downloads its runtime again.
- The Silero VAD model (`vendor/silero-rs/build.rs`), embedded into the app.

## Build from source (Linux)

The release workflow builds Linux on Ubuntu 22.04
(`.github/workflows/release-build-linux.yml`); that build is the reference.
A local build on a current distribution works with the notes below (checked
on Kubuntu 26.10, x86_64, #121).

Packages, as the workflow installs them (Debian and Ubuntu names), plus Rust
and Node.js 20+:

```sh
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
  libasound2-dev libx11-dev libxtst-dev libxrandr-dev libdbus-1-dev libssl-dev pkg-config \
  libclang-dev
```

The workflows pin pnpm to 11.9.0 (`pnpm/action-setup`). Without
a global pnpm, install it locally or run it through npx:

```sh
npm install --prefix ~/.local/share/pnpm-cli pnpm@11.9.0
export PATH=$HOME/.local/share/pnpm-cli/node_modules/.bin:$PATH
(cd frontend && pnpm install --frozen-lockfile)
```

The two sidecars are built and copied as on Windows, with the Linux triple:

```sh
cargo build --release --locked -p llama-helper -p protocol-mcp
mkdir -p frontend/src-tauri/binaries
cp target/release/llama-helper frontend/src-tauri/binaries/llama-helper-x86_64-unknown-linux-gnu
cp target/release/protocol-mcp frontend/src-tauri/binaries/protocol-mcp-x86_64-unknown-linux-gnu
```

**OpenSSL 4 hosts.** llama.cpp's vendored cpp-httplib (`llama-cpp-sys-2`) does
not compile against OpenSSL 4, whose `X509_get_subject_name` returns a
`const X509_NAME*`; Ubuntu 22.04 has OpenSSL 3 and never sees it. The
summary sidecar does not need llama.cpp's HTTPS support, so tell CMake not to
look for OpenSSL (`llama-cpp-sys-2`'s build script passes `CMAKE_*` variables
through). CMake caches the first result, so clean the crate once after the
failed build:

```sh
export CMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON
cargo clean -p llama-cpp-sys-2 --release
cargo build --release --locked -p llama-helper -p protocol-mcp
```

Then build the app as the workflow does, from `frontend/`:

```sh
pnpm exec tauri build --ci --no-bundle -- --locked                          # the binary alone
pnpm exec tauri build --ci --bundles deb --config src-tauri/tauri.deb.conf.json -- --locked
```

A `--no-bundle` binary looks for its resources (ONNX Runtime, the sidecars,
the templates) where a package puts them, under `/usr/lib/<productName>/`, and
logs `Bundled ONNX Runtime unavailable` when run from `target/release`. To run
a local build, extract the deb (`dpkg-deb -x`) and start `usr/bin/protocol`
from the extracted tree.

**AppImage.** Bundling an AppImage fails on Kubuntu 26.10 hosts: linuxdeploy's
GTK plugin stops with `cp: '…/10_gsettings-desktop-schemas.gschema.override'
and '…' are the same file`, because that gschema override is a symlink there.
It also needs `APPIMAGE_EXTRACT_AND_RUN=1` and `NO_STRIP=true` on such hosts.
The deb builds; the AppImage (and its updatable path) comes from the release
workflow on Ubuntu 22.04.

Frontend checks, as run in CI:

```powershell
cd frontend
pnpm run lint
pnpm test
pnpm run build             # tsc -b, then vite build into frontend/out
pnpm run build-storybook
```

`pnpm dev` serves the UI alone at http://localhost:3119; outside Tauri every
command and event goes to the in-memory mock in `src/mocks/`. `tauri dev`
starts its own Vite server on 3118, so both can run at once. `pnpm storybook`
serves the stories at http://localhost:6006. The layout and conventions are in
[UI_ARCHITECTURE.md](UI_ARCHITECTURE.md).

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
