# Contributor and coding-agent orientation

Start with [docs/DEVELOPMENT_MAP.md](docs/DEVELOPMENT_MAP.md). It maps the recording,
transcription, speaker-labeling, model-download, and release paths to their owning
files. Feature qualification notes are linked there; read the relevant note before
changing that subsystem.

## Project lineage

[Protocol](https://github.com/vmedvedevpro/Protocol) is a personal Windows-first
fork. Its code comes from two upstream projects, both MIT licensed:

1. [Meetily](https://github.com/Zackriya-Solutions/meetily) by Zackriya Solutions,
   the original open-source meeting assistant.
2. [Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree) by
   Tyler Buza, a fork of Meetily. Protocol branched from it at `3130d16` and merges
   its changes through the `upstream` remote.

Most notes under `docs/` (releases, qualification, PR integration) are Actually
Free's history. Protocol's own identity (bundle identifier, install and data
folders, registry keys, the in-app updater) is described in
[Fork identity and updates](docs/DEVELOPMENT_MAP.md#fork-identity-and-updates);
planned work is tracked in [GitHub issues](https://github.com/vmedvedevpro/Protocol/issues).

## Fork conventions

- Keep upstream internal names so upstream merges stay small: `MEETILY_*`
  variables, storage and event keys. Rebrand only what identifies the product to
  its users. The Cargo package and executable are `protocol` (`protocol.exe`,
  `cargo test -p protocol`); the library crate stays `app_lib`.
- Sample data is not branding: leave example names in tests, fixtures, and
  placeholders as upstream wrote them.
- Put new features in new modules and keep edits to upstream files minimal. Keep
  the copyright notices of MIT code ported from other projects.
- The in-app updater (`src-tauri/src/updater/`) reads only this repository's
  GitHub releases, downloads only when the user clicks Download, and installs
  only on the user's click or on quit, never while `updater::busy` reports
  work. Do not add other network calls to it; the release feed and signing
  rules are in [docs/AUTO_UPDATE.md](docs/AUTO_UPDATE.md).
- A new long-running operation (recording-adjacent work, inference, a model
  download, an import) registers with the busy registry: a getter its owner
  already keeps, or `updater::busy::hold(BusyReason::…)` for the operation's
  lifetime. Work only the WebView sees reports through
  `markUiActivity`. Otherwise an update can restart the app in the middle of it.
- Do not add `Co-Authored-By` trailers or other AI attribution to commits, PR
  titles, or descriptions.

## Working conventions

- Inspect the current diff before editing; preserve unrelated local work.
- Keep explanations close to non-obvious code: ownership, timestamp units,
  concurrency, lifecycle ordering, and the reason for a constraint. Avoid comments
  that merely restate the next line.
- When changing behavior, update the architecture map or its linked feature note
  with the new data flow, affected interfaces, test coverage, and remaining limits.
- Distinguish implemented, tested, installed locally, and published. A local build
  or installer is not a GitHub release. Check the latest published version before
  choosing a release number; do not increment it for every development rebuild.
- Do not infer identity from a model's speaker number. Preserve microphone/source
  provenance and transcript text/timestamps when changing speaker labels.
- Keep capture nonblocking. Heavy inference belongs on a worker; queues, model
  state, and shutdown behavior need explicit owners and bounded behavior.
- Do not silently substitute another diarization engine after a selected-engine
  failure. Report the failure and retain source labels where appropriate.
- Keep optional-model activation tied to successful completion. Native operations
  can outlive the WebView that invoked them; a JS promise alone is not durable
  ownership of an operation's required native side effects.

## Verification pointers

- Run targeted frontend/native tests for the affected behavior. Mock-heavy Bun
  groups must run as separate invocations; see the map for known groups.
- Serialize Next production builds with native builds/tests embedding
  `frontend/out`. Do not run standalone TypeScript checking during a Next build.
- Releases are built by `.github/workflows/release.yml` from a pushed
  `vX.Y.Z` tag into a draft that the owner publishes; manual runs and pipeline
  PRs are dry runs. The procedure is in
  [WORKFLOWS_OVERVIEW.md](.github/workflows/WORKFLOWS_OVERVIEW.md). Never push
  tags or publish releases unless asked.
- Windows packaging is owned by `frontend/scripts/build-universal-windows.ps1`
  (CPU + Vulkan, one `protocol-windows-x64-setup.exe`); verify the resulting
  payload with `node frontend/scripts/verify-windows-release.mjs`. The release
  rules live in `scripts/release/`; run
  `node --test "scripts/release/test/*.test.mjs"` after changing them.
- Released migrations never change. A new migration needs a
  `text eol=lf` line in `.gitattributes` and an entry from
  `node scripts/release/check-migration-checksums.mjs --add-new`.
- Model/audio-dependent tests are explicitly ignored by default. Report whether
  they actually ran, which type of fixture was used, and what they establish.
- Never commit private recordings, databases, model binaries, crash dumps, local
  signing keys, or diagnostic artifacts. `.build-tools/` contains local helpers,
  not a portable or authoritative public test environment; the release
  workflow's build legs are the reference builds.
