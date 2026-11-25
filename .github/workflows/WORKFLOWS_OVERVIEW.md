# GitHub Actions workflows

Protocol's CI runs the quick checks on every pull request and the full set on
`main` after each merge, and builds releases. Releases are built here, never on
a developer machine: one installer per platform, with checksums, updater
signatures and build-provenance attestations, in a **draft** release that the
owner publishes by hand. The draft holds Windows and Linux; macOS joins the
same release when its leg finishes, before or after the publish
([macOS joins later](#macos-joins-later)). All builds are unsigned (no Windows
or Apple certificate yet).

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `pr-checks.yml` | pull requests, pushes to `main`, called by `release.yml` | Frontend lint, Vitest, `tsc -b` and Vite build, Storybook build; release-script tests and the migration checksum table |
| `release.yml` | tag `v*`; pushes to `main` and manual runs as **dry runs** | Validates, runs the checks, builds all three platforms, creates the draft from Windows and Linux and adds macOS when its leg finishes (tag), or the same as dry-run artifacts |
| `release-build-windows.yml` | called by `release.yml` | `windows-2022`: CPU + Vulkan installer, native tests, payload check, install/start/uninstall on the runner |
| `release-build-macos.yml` | called by `release.yml` | `macos-15`: Apple Silicon DMG and updater bundle, native tests, bundle checks, two launches; nothing waits for it |
| `release-build-linux.yml` | called by `release.yml` | `ubuntu-22.04`: AppImage and deb as two builds (the deb uses the distribution's ffmpeg), package checks, start under Xvfb; native tests do not block yet |
| `updater-e2e.yml` | pushes to `main` (Windows, Linux), manual runs (also macOS) | On each platform, an old build under a test identity updates itself to a new one from a localhost feed ([AUTO_UPDATE.md](../../docs/AUTO_UPDATE.md)); the macOS job runs only by hand and gates no tag |
| `release-published.yml` | release published | Downloads the public assets anonymously and checks checksums, `latest.json`, signatures and `/releases/latest`, for the platforms the release has by then |

Everything a job decides lives in tested scripts under `scripts/release/`
(`node --test "scripts/release/test/*.test.mjs"`), so it can be run locally the
same way. The Windows build itself is `frontend/scripts/build-universal-windows.ps1`.

## Pull requests and `main`

A pull request runs only `pr-checks.yml` (1–3 minutes); no Rust is built or
tested there. The push of each merge to `main` runs `pr-checks.yml`, the
`release.yml` dry run (25–50 minutes; its legs run the native tests on every
platform, blocking on Windows and macOS) and `updater-e2e.yml` (20–45 minutes).
A push that changes only documentation (`docs/`, any `README.md`, `AGENTS.md`,
`ARCHITECTURE.md`, `PRIVACY_POLICY.md`, `LICENSE*`, Markdown under `.github/`,
`frontend/src-tauri/*.md`) runs only `pr-checks.yml`. `CHANGELOG.md` is not on
that list: the dry run's notes and `latest.json` come from it. A newer push to
`main` cancels the older run of the same workflow; tag runs and manual runs are
never cancelled by it.

`main` has no branch protection, so a red run blocks nothing by itself. It
means that commit is not released, and the fix goes in through a pull request
like any other change. A pipeline or updater change is first exercised in full
after it merges; to try it before, start the workflow on its branch by hand:
`gh workflow run release.yml --ref <branch>` or
`gh workflow run updater-e2e.yml --ref <branch>`.

## Release assets

| Asset | For |
| --- | --- |
| `protocol-windows-x64-setup.exe` | People (the Windows download) **and** the updater: Tauri's NSIS installer, run by the updater with `/P /UPDATE` |
| `protocol-macos-arm64.dmg` | People |
| `protocol-macos-arm64.app.tar.gz` | The updater on macOS |
| `protocol-linux-x86_64.AppImage` | People and the updater |
| `protocol_<version>_amd64.deb` | People (experimental; does not update itself) |
| `*.sig` | Updater signatures of the three updater payloads, made with the production key |
| `latest.json` | The updater feed: `windows-x86_64-nsis`, `windows-x86_64`, `linux-x86_64-appimage`, and `darwin-aarch64-app` and `darwin-aarch64` once macOS has joined; no deb or generic Linux entry |
| `SHA256SUMS.txt` | `sha256sum -c` list of every other asset |

The three macOS files and the two darwin entries arrive together, after the
draft; until then the release notes say the macOS download follows.

Installed apps read `https://github.com/vmedvedevpro/Protocol/releases/latest/download/latest.json`,
which only ever resolves to the published release marked **Latest**: drafts and
prereleases are invisible to them.

## Releasing a version

1. **Release PR.** On a branch from `main`:

   ```powershell
   node scripts/release/bump-version.mjs 0.3.0
   cargo metadata --locked --format-version 1 > $null
   ```

   This sets the version in `tauri.conf.json`, `frontend/src-tauri/Cargo.toml`,
   `Cargo.lock` and `frontend/package.json`, and turns `## Protocol — unreleased`
   in `CHANGELOG.md` into `## Protocol 0.3.0 — <today>` (UTC; `--date YYYY-MM-DD`
   sets another) under a new, empty unreleased heading; `cargo metadata` then
   confirms that `Cargo.lock` still matches. Review the section: it becomes the
   release notes and the text the updater shows. Merge the PR.

2. **Wait for a green `main`, then tag that commit.** The merge starts
   `pr-checks.yml`, the `release.yml` dry run and `updater-e2e.yml` on the
   merged commit. Tag only a commit on which every job of these three runs
   succeeded **except the macOS ones**: `pr-checks.yml`; `validate`,
   `frontend-checks`, the Windows and Linux legs and `preview` of the dry run;
   the `windows` and `linux` jobs of `updater-e2e.yml`. The macOS jobs
   (`build-macos`, `preview-macos`, the `macos` job of `updater-e2e.yml`,
   which runs only by hand) do not gate a tag, so the run of a workflow can be red or still going
   because of them alone:

   ```powershell
   git fetch origin
   $sha = git rev-parse origin/main   # the release PR's merge commit
   gh run list -R vmedvedevpro/Protocol --commit $sha --event push --json databaseId,workflowName,status,conclusion
   # For each run: every line must say success (draft and join-macos say skipped).
   gh run view <databaseId> -R vmedvedevpro/Protocol --json jobs --jq '.jobs[] | select(.name | test("macos") | not) | "\(.conclusion) \(.name)"'
   ```

   If another pull request merged after the release PR, set `$sha` to the
   release PR's merge commit instead
   (`gh pr view <number> -R vmedvedevpro/Protocol --json mergeCommit --jq .mergeCommit.oid`).
   A gating job that is still going, failed or was cancelled is not green. A
   macOS job that is red, waiting for a `macos-15` runner or cancelled for
   lack of one does not hold the tag; a red one is fixed in a follow-up pull
   request, and the tag run's own macOS leg is what has to pass (step 3). A
   documentation-only commit starts no dry run and is never the one to tag.

   Then tag it and push only this tag (never `git push --tags`):

   ```powershell
   git tag -a v0.3.0 $sha -m "Protocol 0.3.0"
   git push origin refs/tags/v0.3.0
   ```

   A clone with the `upstream` remote has Meetily's own `v0.3.0` and `v0.4.0`
   tags locally, and `git tag` refuses an existing name. Remove them once and
   stop fetching upstream tags:

   ```powershell
   git tag -d v0.3.0 v0.4.0
   git config remote.upstream.tagOpt --no-tags
   ```

3. **The run.** `release.yml` starts on the tag. `validate` fails the run unless
   the tag is `vX.Y.Z` or `vX.Y.Z-rc.N`, the tagged commit is on `origin/main`,
   the four version files and a non-empty `## Protocol <version>` CHANGELOG
   section match, the version is above every published release (RCs and
   releases taken off Latest with `--prerelease` included), the release is
   not published yet, the
   updater configuration is complete (`createUpdaterArtifacts`, `pubkey`, the
   endpoint above, `requireSignedVersion`), the locked tauri-cli can sign with
   `--app-version` (2.12 or later), and the migration checksum table matches.
   Then the frontend checks and the three build legs run (about 40 minutes
   with cold Rust caches, almost all of it the Windows leg). Once the Windows
   and Linux legs are done, `draft` signs their updater payloads with the
   production key, verifies the signatures against the key in
   `tauri.conf.json`, writes `latest.json`, `SHA256SUMS.txt` and the notes for
   those two platforms, attests the installers, and creates the **draft**
   release. Its job summary links the draft. The macOS leg runs on whenever a
   `macos-15` runner takes it, and `join-macos` then adds macOS to the same
   release ([macOS joins later](#macos-joins-later)).

4. **Review and publish.** Read the notes, download
   `protocol-windows-x64-setup.exe` from the draft, install it and record a
   short meeting. Then publish with **Set as the latest release** checked, or:

   ```powershell
   gh release edit v0.3.0 --draft=false --latest
   ```

   There is no need to wait for macOS. Every installed earlier Windows and
   Linux version is offered the update from this moment, macOS installs from
   the moment `join-macos` has added macOS. An RC is published as a
   prerelease and is never offered to installed apps.

5. **Check.** `release-published.yml` runs on publish and checks the
   platforms the release has at that moment; `join-macos` checks the public
   release again after it adds macOS to a published one. If either check
   fails, take the release off `/releases/latest` at once
   (`gh release edit v0.3.0 --prerelease`) and ship a fixed version. A
   `release-published.yml` run that overlapped with `join-macos`'s uploads can
   fail on the half-replaced `latest.json` or `SHA256SUMS.txt`; re-run it
   once `join-macos` has finished before concluding anything.

### macOS joins later

macOS runners are scarce, and waiting for them could hold a release back by
up to a day, so nothing waits for the macOS leg (#164). `join-macos` starts
after `build-macos` and `draft`, whether the owner has published the release
by then or not, and:

1. reads the release of the run's tag (and only that release: every call
   goes to that tag or its id) with its `latest.json`, `SHA256SUMS.txt` and
   body;
2. checks the macOS leg's files, signs `protocol-macos-arm64.app.tar.gz`
   with the production key and verifies the signature against the key in
   `tauri.conf.json`, as `draft` does (`scripts/release/join-macos.sh`);
3. merges `darwin-aarch64-app` and `darwin-aarch64` into `latest.json` and
   the macOS lines into `SHA256SUMS.txt`
   (`scripts/release/merge-macos.mjs`), refusing a feed or list of another
   version, and renders the body again with the macOS download. A body the
   owner edited by hand, also while the job was running (it reads the body
   again right before it writes), is left alone; the job summary then says to
   add the macOS row and checksums by hand;
4. attests the DMG and the bundle, uploads the DMG, the bundle and its `.sig`,
   then `SHA256SUMS.txt`, then `latest.json` (`--clobber`; the feed last, so it
   never points at a missing file), and checks the release's assets by name
   and digest. The Releases API cannot replace an asset in place: `--clobber`
   deletes it and uploads the new one, so on a published release
   `latest.json` and `SHA256SUMS.txt` are missing for a moment on every run,
   and installed apps that check just then see no update until their next
   check. The `.sig`, the checksums and the feed are made again on every run
   and always uploaded; only the DMG and the bundle are skipped when the
   release already has the same bytes (a re-run of this job alone);
5. on a published release, downloads it anonymously and checks it the way
   `release-published.yml` does.

Re-running it is safe: the macOS entries are replaced and everything else
stays as it was. Until it has run, macOS installs stay on their version and a
manual check there says the update is not available for macOS yet.

### When a tag run fails

Nothing is public until the draft is published, and the updater sees only
published releases, so a failed run leaves only the tag (and maybe a draft,
which the next run replaces).

- A transient failure (network, runner): **Re-run failed jobs** on the run.
- A red or cancelled macOS leg, or a red `join-macos`, holds nothing back:
  publish the Windows and Linux release as usual. A macOS leg that failed for
  a passing reason (no runner, a flaky step): **Re-run failed jobs** on the
  tag run, also after the release is published; `build-macos` and
  `join-macos` run again against the same release (within GitHub's 30-day
  re-run window). One that needs a code fix is fixed in a follow-up pull
  request. While the release is still a draft, the tag can move to the fixed
  commit as below, which rebuilds every platform; once it is published, the
  tag stays, that version ships without macOS, and the next version brings
  the fix to macOS installs.
- A failure that needs a fix: merge the fix to `main`, wait until that
  commit's `main` runs are green (step 2), then move the tag to it and push it
  again; the new run starts on its own. Cancel the old tag run first if it is
  still going (it may be waiting for a macOS runner): runs of one tag share a
  concurrency group that is never cancelled, so the new run would wait behind
  it:

  ```powershell
  gh run list -R vmedvedevpro/Protocol --workflow release.yml --branch v0.3.0 --json databaseId,status --jq '.[] | select(.status != "completed")'
  gh run cancel <databaseId> -R vmedvedevpro/Protocol   # each run listed
  git push origin :refs/tags/v0.3.0
  git fetch origin
  $sha = git rev-parse origin/main   # the fix's merge commit, green on main
  git tag -f -a v0.3.0 $sha -m "Protocol 0.3.0"
  git push origin refs/tags/v0.3.0
  ```

  A fix that changes the CHANGELOG section or the version needs the release PR
  updated first, like any other fix.

## Dry runs

A dry run builds and checks everything a release would, signs the updater
payloads with a throwaway key and creates no release. The release rules
(CHANGELOG section, version order, updater configuration, tauri-cli version)
are reported as warnings so a branch can rehearse; the version files must
still agree. It never reaches the `release` environment or the production key.
Between releases a `main` dry run warns that its version is already
published; that is expected.

- Every push to `main` except a documentation-only one runs one automatically
  (see [Pull requests and `main`](#pull-requests-and-main)).
- Any branch, by hand, for example to try a pipeline change before it merges:
  `gh workflow run release.yml --ref <branch> [-f version=<the files' version>]`.

Like a tag run, a dry run does not wait for macOS: `preview` assembles
Windows and Linux as soon as their legs are done, and `preview-macos` joins
macOS to that preview with `join-macos.sh` when the macOS leg finishes, so a
broken macOS build or merge shows as a red job without holding anything.

Artifacts of a dry run: `leg-windows`, `leg-macos`, `leg-linux` (the
installers), `release-dry-run` (Windows and Linux: `latest.json`,
`SHA256SUMS.txt`, the `.sig` files and `notes.md`), `release-dry-run-macos`
(the same merged with macOS, signed with a second throwaway key), and
`logs-*` (startup logs). The job summaries of `preview` and `preview-macos`
show the checksums and the feed.

## The `release` environment (owner, once)

Only the `draft` and `join-macos` jobs use the environment, and it admits only
tag runs. Create
the updater key pair, then the environment with a tag policy and the key's two
secrets (Git Bash, from the repository root):

```bash
read -rs PW   # the key's password; not echoed, not kept in the shell history
(cd frontend && pnpm exec tauri signer generate --ci -p "$PW" -w ~/.tauri/protocol-updater.key)
gh api -X PUT repos/vmedvedevpro/Protocol/environments/release -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
gh api -X POST repos/vmedvedevpro/Protocol/environments/release/deployment-branch-policies -f 'name=v*' -f type=tag
gh secret set TAURI_SIGNING_PRIVATE_KEY -R vmedvedevpro/Protocol --env release < ~/.tauri/protocol-updater.key
printf '%s' "$PW" | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R vmedvedevpro/Protocol --env release
unset PW
```

The public key, `~/.tauri/protocol-updater.key.pub`, goes into
`plugins.updater.pubkey` in `frontend/src-tauri/tauri.conf.json`. Do not pipe
the key or the password through Windows PowerShell 5.1 (`Get-Content -Raw … |
gh secret set`): it can append a line break, and the secret then no longer
matches the key file. `-R` is needed in a clone with an `upstream` remote,
where `gh secret set` refuses to guess the repository.

Check the policy with
`gh api repos/vmedvedevpro/Protocol/environments/release/deployment-branch-policies`:
it should list one policy, `v*` of type `tag`. Keep an offline copy of the key
file and its password: losing either strands every installed copy on its
version. No other secrets are used.

## Runners, caches, time

- `windows-2022` (Visual Studio 2022; `windows-latest` moved to VS 2026),
  `macos-15` (arm64), `ubuntu-22.04` for the Linux packages (oldest supported
  glibc), `ubuntu-24.04` for the rest. Rust 1.99.1 in every leg.
- Caches: Rust per leg (`swatinem/rust-cache`), the pnpm store, the LLVM 18
  archive (Windows). The Vulkan SDK installer is downloaded on every run: the
  cache of `humbletim/install-vulkan-sdk` is off because it uses
  `actions/cache@v4`, which targets Node.js 20. Caches saved by a `main` run
  are visible to later `main` runs, to pull requests and, by GitHub's rule
  that any run can restore the default branch's caches, to tag runs; no tag
  run has shown that yet. Caches saved by a tag run are visible only to that
  tag.
- Actions are pinned by full commit SHA with the release as a comment, and
  every JavaScript action, including those inside composite actions, must
  target Node.js 24: the runner warns about Node.js 20 actions and will stop
  running them.
- Line endings are set before checkout (`core.autocrlf true` on Windows, `false`
  elsewhere): the historical migrations' checksums depend on them, and each leg
  checks the files it embeds against `released-migration-checksums.json`.

## Removed upstream workflows

`build.yml`, `build-test.yml`, `build-windows.yml`, `build-devtest.yml`,
`build-linux.yml`, `build-macos.yml`, `publish-macos.yml`,
`smoke-test-macos-release.yml`, `submit-virustotal.yml`, `pr-main-check.yml` and
their guides (`ACCELERATION_GUIDE.md`, `README_DEVTEST.md`, `MACOS_RELEASE.md`)
were Meetily – Actually Free's release process: DigiCert and Apple signing,
upstream asset names, a separate macOS publication, a VirusTotal upload, and
secrets this repository does not have. `release.yml` and its legs replace them;
the macOS bundle checks moved into `release-build-macos.yml`.
