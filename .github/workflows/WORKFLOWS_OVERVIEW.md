# GitHub Actions workflows

Protocol's CI runs the quick checks on every pull request and the full set on
`main` after each merge, and builds releases. Releases are built here, never on
a developer machine: one installer per platform, with checksums, updater
signatures and build-provenance attestations, in a **draft** release that the
owner publishes by hand. All builds are unsigned (no Windows or Apple
certificate yet).

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `pr-checks.yml` | pull requests, pushes to `main`, called by `release.yml` | Frontend tests, Next.js build, `tsc`; release-script tests and the migration checksum table |
| `release.yml` | tag `v*`; pushes to `main` and manual runs as **dry runs** | Validates, runs the checks, builds all three platforms, then creates the draft (tag) or a dry-run artifact |
| `release-build-windows.yml` | called by `release.yml` | `windows-2022`: CPU + Vulkan installer, native tests, payload check, install/start/uninstall on the runner |
| `release-build-macos.yml` | called by `release.yml` | `macos-15`: Apple Silicon DMG and updater bundle, native tests, bundle checks, two launches |
| `release-build-linux.yml` | called by `release.yml` | `ubuntu-22.04`: experimental AppImage and deb, package checks, start under Xvfb; native tests do not block yet |
| `updater-e2e.yml` | pushes to `main`, manual runs | On all three platforms, an old build under a test identity updates itself to a new one from a localhost feed ([AUTO_UPDATE.md](../../docs/AUTO_UPDATE.md)) |
| `release-published.yml` | release published | Downloads the public assets anonymously and checks checksums, `latest.json`, signatures and `/releases/latest` |

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
| `protocol-linux-x86_64.AppImage` | People and the updater (experimental) |
| `protocol_<version>_amd64.deb` | People (experimental; does not update itself) |
| `*.sig` | Updater signatures of the three updater payloads, made with the production key |
| `latest.json` | The updater feed: `windows-x86_64-nsis`, `windows-x86_64`, `darwin-aarch64-app`, `darwin-aarch64`, `linux-x86_64-appimage`; no deb or generic Linux entry |
| `SHA256SUMS.txt` | `sha256sum -c` list of every other asset |

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
   merged commit. Tag only a commit whose `main` runs of all three succeeded:

   ```powershell
   git fetch origin
   $sha = git rev-parse origin/main   # the release PR's merge commit
   gh run list -R vmedvedevpro/Protocol --commit $sha --event push
   ```

   If another pull request merged after the release PR, set `$sha` to the
   release PR's merge commit instead
   (`gh pr view <number> -R vmedvedevpro/Protocol --json mergeCommit --jq .mergeCommit.oid`).
   A run that is still going, failed or was cancelled is not green. That
   includes a run whose macOS leg was cancelled because no `macos-15` runner
   became available: do not tag; whether to re-run it (**Re-run failed jobs**)
   is the owner's call. A documentation-only commit starts no dry run and is
   never the one to tag.

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
   with cold Rust caches, almost all of it the Windows leg), and `draft`
   signs the updater payloads with the production key, verifies the signatures
   against the key in `tauri.conf.json`, writes `latest.json`, `SHA256SUMS.txt` and the notes,
   attests the installers, and creates the **draft** release. Its job summary
   links the draft.

4. **Review and publish.** Read the notes, download
   `protocol-windows-x64-setup.exe` from the draft, install it and record a
   short meeting. Then publish with **Set as the latest release** checked, or:

   ```powershell
   gh release edit v0.3.0 --draft=false --latest
   ```

   Every installed earlier version is offered the update from this moment.
   An RC is published as a prerelease and is never offered to installed apps.

5. **Check.** `release-published.yml` runs on publish. If it fails, take the
   release off `/releases/latest` at once (`gh release edit v0.3.0 --prerelease`)
   and ship a fixed version.

### When a tag run fails

Nothing is public until the draft is published, and the updater sees only
published releases, so a failed run leaves only the tag (and maybe a draft,
which the next run replaces).

- A transient failure (network, runner): **Re-run failed jobs** on the run.
- A failure that needs a fix: merge the fix to `main`, wait until that
  commit's `main` runs are green (step 2), then move the tag to it and push it
  again; the new run starts on its own:

  ```powershell
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

Artifacts of a dry run: `leg-windows`, `leg-macos`, `leg-linux` (the
installers), `release-dry-run` (`latest.json`, `SHA256SUMS.txt`, the `.sig` files
and `notes.md`), and `logs-*` (startup logs). The job summary of `preview` shows
the checksums and the feed.

## The `release` environment (owner, once)

Only the `draft` job uses the environment, and it admits only tag runs. Create
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
