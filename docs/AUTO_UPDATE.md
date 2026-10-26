# In-app updates

Protocol updates itself from this repository's GitHub releases (#31). It
follows Orca's model: a quiet background check, a download only when the user
clicks **Download**, and an install only when the user clicks **Restart and
update** or quits. Nothing installs while Protocol is recording or processing a
meeting. Owners and the data flow are summarized in
[DEVELOPMENT_MAP.md](DEVELOPMENT_MAP.md#fork-identity-and-updates); this note
holds the decisions, the per-platform behaviour, the failure states, the test
procedures and their results, and the remaining limits.

## What the user sees

| State | Sidebar pill (above Settings) | Tray | Settings › About |
| --- | --- | --- | --- |
| Up to date | hidden | Check for Updates… | "Protocol is up to date. Last checked …" |
| Release found | Update available · X.Y.Z | Update Available · X.Y.Z | "Protocol X.Y.Z is available." **Download** |
| Downloading | Downloading · N% | Downloading Update… (disabled) | progress bar |
| Download requested during a recording | Update available · X.Y.Z | Update Available · X.Y.Z | "The download starts after the recording." |
| Downloaded and verified | Restart and update · X.Y.Z | Restart to Update to X.Y.Z | **Restart and update** |
| Downloaded, Protocol busy | Restart and update · X.Y.Z | Update Ready — Protocol Is Busy (disabled) | button disabled, "Protocol can't restart while …" |
| Download or install failed | Update failed · X.Y.Z | as before the failure | the error sentence and **Try again** |

The pill opens a panel with the release notes (the CHANGELOG section from the
feed, rendered without raw HTML or images), a link to the release on GitHub,
and **Download** or **Restart and update**. One toast per version announces an
available release, a download that finished in this session, and, after the
restart, "Updated to Protocol X.Y.Z"; toasts wait while a recording runs and are
remembered in `localStorage` (`protocol-updater-seen-v1`). On macOS the panel
and Settings add that the system may ask again for microphone and screen
recording access.

The tray's Settings, Check for Updates… and Update Available items, and a
Restart to Update that was refused or failed, open Settings (› About) through
the page's router (`tray-navigate` event): a reload would drop a meeting that
is still being saved after a recording, and the queued post-call jobs. A
refusal's reason stays next to **Restart and update** until the work ends, or
for 10 seconds when the work is not one the status lists (the speech engine's
lock). The button is disabled while a check, download or install runs.

Every text that describes the feature says that the download waits for a click:
Settings › About (identity card and switch description), the panel, the
onboarding overview, `PRIVACY_POLICY.md`, `README.md`, and `CHANGELOG.md`.
`tests/updater/wording.test.ts` pins the Settings and panel sentences.

## Decisions

- **Download on click.** A background check only finds a release. The user
  starts the download; a download never starts during a recording and is
  cancelled when one starts, then restarts on its own afterwards. A requested
  download that failed waits for **Try again**.
- **Checks.** On by default, at most daily: the scheduler ticks every 10
  minutes (first after 2 minutes), checks when 24 hours have passed since the
  last completed check, and backs off 1/2/4/6 hours after failed automatic
  checks. A failed manual check does not count, and no retry comes earlier
  than 24 hours after the last completed check. Future timestamps (clock moved
  back) are clamped. No automatic check before
  onboarding completes. A manual check always runs and joins a check started
  less than 5 seconds earlier. The switch is in Settings › About and is stored
  in the plugin store `updater.json` (`autoCheck`, `lastCheckedAt`,
  `lastAttemptAt`, `failures`).
- **Pulled releases.** A check that finds nothing newer drops the offer and its
  cached download, so a release that was pulled is not installed. A newer
  release replaces the offer (and deletes the older download).
- **Install only when idle.** See [Install gate](#install-gate).
- **Quit.** Tray Quit, and on macOS ⌘Q and Dock Quit, install a downloaded
  update without relaunch when nothing is busy; the next start runs the new
  version. Otherwise they quit as before. A quit during a recording keeps the
  current behaviour (#32) and never installs. macOS and Linux skip the install
  on quit when the app's folder is not writable instead of raising an
  administrator prompt. On Windows only tray Quit installs: closing the window
  hides it to the tray.
- **No process plugin.** Restarts use Tauri's own `AppHandle::request_restart`.

## Feed, keys and assets

- Endpoint: `https://github.com/vmedvedevpro/Protocol/releases/latest/download/latest.json`
  (`plugins.updater.endpoints`). Draft and pre-releases are never Latest, so
  they are never offered.
- Lookup order is `{os}-{arch}-{installer}`, then `{os}-{arch}`. Windows reads
  `windows-x86_64-nsis` and `windows-x86_64`, both pointing at
  `protocol-windows-x64-setup.exe` (the NSIS installer is also the updater
  payload; its `.sig` sits next to it). macOS reads `darwin-aarch64-app`
  (`protocol-macos-arm64.app.tar.gz`), Linux `linux-x86_64-appimage`. `.deb`
  installs check `linux-x86_64-appimage` too but only show a link. The release
  pipeline (#15) writes the feed and validates the updater configuration.
- `requireSignedVersion: true`: each minisign signature carries the version it
  was made for in its trusted comment, so a tampered feed cannot pair an old
  signed installer with a newer version number. `tauri build` adds the version;
  a hand-signed file needs `tauri signer sign --app-version X.Y.Z`.
- `plugins.updater.pubkey` holds the owner's production public key (minisign
  key ID `8A2223F21A78A38A`). Installed copies trust only the key compiled into
  them, so every release must be signed with its private key, which lives in
  the `release` environment's secrets
  ([WORKFLOWS_OVERVIEW.md](../.github/workflows/WORKFLOWS_OVERVIEW.md)) and in
  the owner's offline copy. Test builds (the end-to-end runs) override the key
  with their own.
- `bundle.createUpdaterArtifacts: true` makes `tauri build` sign the updater
  bundle, so a build needs `TAURI_SIGNING_PRIVATE_KEY` (a throwaway key is fine
  for local and CI builds; the release job signs the final files again) or
  `--no-sign`, which also skips Windows code signing and the macOS ad-hoc
  signature.
- The WebView cannot install anything except through `updater_install_now`,
  which applies the gate; the plugin's JavaScript API is not permitted.

## Which copies update

`updater::support` reads the bundle-type marker Tauri patches into the
executable:

| Copy | Behaviour |
| --- | --- |
| NSIS install (Windows) | checks, downloads, installs |
| `.app` from the DMG or the updater bundle (macOS), run from its bundle | checks, downloads, installs |
| AppImage (Linux) | checks, downloads, installs (replaces the AppImage) |
| `.deb` / `.rpm` | checks, links to GitHub |
| Development build, unpatched executable, portable copy | never checks; Settings explains why |

## Install gate

`updater::install::install_now`:

1. Requires a downloaded, verified update.
2. Takes the engine lifecycle lock (2 s timeout). Holding it blocks a
   recording start, including one from meeting detection, and batch
   transcription. Import and retranscription set their flags before they wait
   for this lock, so step 3 sees them.
3. Re-reads the busy registry and refuses with the reasons. When the lock was
   not taken, "the speech engine is busy" comes after the operation that holds
   it (an import holds the lock while it transcribes), so the user reads "an
   audio import is running" first.
4. Moves the state machine to installing (a second install cannot start).
5. Checks the app's location (macOS and Linux, below) before it reads the
   payload: a quit skips the install, a click shows the error.
6. Reads the cached payload (size and SHA-256 checked against the cache entry).
7. `prepare_exit`: WAL checkpoint without closing the pool, llama-helper
   stopped (it starts again on demand), crash session closed so the next start
   does not report a crash.
8. Writes an install marker (`from`, `to`, time) next to the cache.
9. Hands the payload to the plugin, which verifies the signature again.

If the install fails before the process exits, the crash session is reopened,
the lock is released, and the error is shown; a signature failure also deletes
the download. On the next start the marker says whether the update worked
("Updated to" toast) or did not finish ("The update to X.Y.Z didn't finish").

### Busy reasons and their owners

| Reason | Owner |
| --- | --- |
| `recording`, `recordingStopping` | `audio::recording_commands` (`is_recording_active`, `is_stopping`) |
| `recordingSave` | WebView lease: `RecordingStateContext` stopping, processing or saving |
| `import` | `audio::import::is_import_in_progress` |
| `retranscription` | `audio::retranscription::is_retranscription_in_progress` |
| `diarization` | `busy::hold` in `diarization::diarize_meeting` |
| `summary` | `summary::service::active_summary_count` |
| `postCall` | WebView lease: `PostCallJobsProvider` queue |
| `modelDownload` | `busy::hold` in the Whisper, Parakeet, built-in AI, diarization and Ollama downloads |
| `onboarding` | onboarding status not completed |
| `speechEngine` | the gate could not take the engine lifecycle lock |

The WebView reports its activities as a full set through
`updater_set_ui_activity` on every change and every 60 seconds; native code
drops the set after 150 seconds without a report, so a closed or crashed
WebView cannot block updates forever. A new long-running operation must
register here (AGENTS.md).

## Per-platform install

- **Windows.** The plugin writes the installer to
  `%TEMP%\<productName>-<version>-updater-XXXX` and runs it with
  `ShellExecuteW` as `/P /UPDATE` plus `/R` for **Restart and update**, then
  calls `std::process::exit(0)`, so `RunEvent::Exit` does not run (hence
  `prepare_exit`). The passive NSIS window shows "Updating Protocol"; the
  installer's running-app check and hooks stop only this install's
  executable. The plugin never deletes its temp folder; the scheduler removes
  folders matching `<productName>-*-updater-*` on its first tick.
- **macOS.** The plugin extracts `Protocol.app.tar.gz` and swaps the bundle in
  place (asking for an administrator password only when the folder is not
  writable), then the app restarts (`request_restart`) or exits. The install
  runs off the main thread because the plugin uses the main thread for its
  prompt. A translocated app (run from a quarantined download) is refused with
  "Move Protocol to the Applications folder".
- **Linux.** The plugin replaces the file named by `$APPIMAGE`, then the app
  restarts or exits. A read-only folder is refused, and the message points to
  the new AppImage on GitHub.

## Failure states

| Kind | Sentence (lib/updater.ts) | Shown |
| --- | --- | --- |
| `network` | Couldn't reach GitHub. Check your connection and try again. | manual check, download |
| `noRelease` | No published release found. | manual check only |
| `noPlatform` | A newer version isn't available for <platform> yet. | manual check only |
| `feed` | The update information on GitHub couldn't be read. | manual check |
| `signature` | The downloaded update failed its signature check and was deleted. Nothing was installed. | download, install |
| `download` | The download stopped: … | download |
| `diskSpace` | Not enough free disk space for the update. | download (needs 3× the payload free) |
| `installStart` | The installer couldn't start (…). Protocol is still running. | install |
| `installIncomplete` | The update to X.Y.Z didn't finish. Protocol is still on … | next start |
| `location` | Move Protocol to the Applications folder… / the AppImage folder is read-only | install |

Background check failures never replace a visible error and appear only as
"Last check failed …" in Settings. A failed manual check is the status line
when nothing is offered and an alert under the offer otherwise (the tray's
Check for Updates opens Settings). Every event is appended to
`app_cache_dir()/updates/updater.log` (256 KiB, one `.old` rotation; versions,
error kinds and messages, no user data).

## Files

| File | Windows location |
| --- | --- |
| Downloaded payload, its feed entry, install marker, `updater.log` | `%LOCALAPPDATA%\io.github.vmedvedevpro.protocol\updates` |
| Preferences (`updater.json`) | `%APPDATA%\io.github.vmedvedevpro.protocol` |
| Installer temp folder | `%TEMP%\Protocol-<version>-updater-XXXX` (removed on a later start) |

## Tests

- **Native unit tests** (`cargo test -p protocol --lib updater::`): the state
  machine (offers, downloads, pulled releases, error visibility), schedule and
  backoff, busy reasons and the UI lease, the cache (atomic store, size and
  hash check, marker outcomes, temp-folder cleanup), support detection, error
  mapping, a feed fixture resolved through the plugin's `RemoteRelease` for
  every key, the gate's decisions, and the gate lock blocking a recording
  start.
- **Frontend** (`frontend/tests/updater/`): wording per state, the pill label,
  the panel's Download and Restart and update with busy refusals (one the
  status never lists clears after 10 seconds; the button waits for a running
  check), the macOS note and the `.deb` link, Settings' check and switch, a
  failed manual check next to an offer, toasts once per version,
  and the activity reporter's full-set, renewal and unmount behaviour.
- **End to end**: see below.

## End-to-end procedures

### CI (`.github/workflows/updater-e2e.yml`)

Built with the test-only cargo feature `updater-e2e`, which release builds
never enable. Started with `--updater-e2e-result=<file>`, such a build skips the
scheduler and the UI: it checks, downloads, installs and restarts on its own,
ignoring only the onboarding reason (a fresh profile never finishes
onboarding). The relaunched build writes `{outcome, version, from}` to the file
and exits. The flag is an argument rather than an environment variable because
the Windows installer relaunches through the shell, which keeps `/ARGS` but not
the environment.

Per platform: an ephemeral key pair, build A (9.0.0) and B (9.0.1) under the
`Protocol E2E` identity (`frontend/scripts/updater-e2e.mjs config`) with a
`http://127.0.0.1:8765` feed (`feed`, `serve`), install A (Windows: silent NSIS
into the runner's temp folder; macOS: the `.app` in `$RUNNER_TEMP/Applications`;
Linux: the AppImage on a standalone Xvfb, since `xvfb-run` would stop the
display when the old process exits), start it, wait for the result, and assert
9.0.1 updated from 9.0.0 plus the replaced files (Windows file version, macOS
`Info.plist`, Linux AppImage hash). If the Windows installer replaces the app
but does not relaunch it (its `RunAsUser` needs the interactive shell), the job
starts the new copy itself and records a warning. The workflow runs on manual
dispatch and on pull requests that touch the updater, the installer, the Tauri
configuration or the workflow.

### Local Windows (QA identity)

A QA build with `productName` `Protocol QA`, identifier
`io.github.vmedvedevpro.protocol.qa` and `mainBinaryName` `protocol-qa`,
installed under `C:\Users\User\protocol-qa\`, a test key and a localhost feed.
The installer's hooks are checked to stop only `protocol-qa.exe` before the
first install; the copy is uninstalled and its folder removed afterwards.

## Results

### Local Windows, 2026-10-26

Windows 11, QA identity, NSIS builds 0.3.0 to 0.3.3 of this branch (Vulkan
feature) signed with a test key, feed on `http://127.0.0.1:8765`. The app was
driven through its UI and its tray menu; the evidence (screenshots, journal,
feed log, registry and folder snapshots) stays outside the repository.

| Scenario | Result |
| --- | --- |
| Manual check | Pill "Update available · 0.3.1", one toast, notes in the panel and Settings. The feed log shows only `latest.json`: nothing downloaded before the click. |
| Download | One request for the installer, "verified and cached", pill "Restart and update · 0.3.1". |
| Busy | During an import the tray item was disabled ("Update Ready — Protocol Is Busy"); during a model download Settings said "Protocol can't restart while a model is downloading." with the button disabled, and enabled it again when the download finished. |
| Quit while busy | Tray Quit during an import exited without installing (journal: install refused, busy); the next start restored the downloaded update without a new request to the feed. |
| Restart and update | 0.3.0 → 0.3.1 and 0.3.2 → 0.3.3: passive installer with `/P /UPDATE /R`, relaunch about 15 s later, "Updated to Protocol 0.3.x" toast, meetings and settings kept, no crash report. |
| Install on quit | 0.3.1 → 0.3.2 from the tray's Quit: installer with `/P /UPDATE` and no `/R`, nothing started afterwards; the next start reported the update. |
| Automatic check | With the last check 25 hours old, the first scheduler tick (2 minutes after start) found 0.3.2 and removed the leftover installer folder. |
| Corrupted payload | One byte flipped: "failed its signature check and was deleted. Nothing was installed.", cache empty. |
| Payload signed for another version | A 0.3.4 feed entry with the 0.3.3 installer was refused by the plugin's version check (signature error), nothing installed. |
| Feed unreachable | Manual check: "Couldn't reach GitHub. Check your connection and try again." next to the existing offer. |
| Switch off | Saved as `autoCheck: false`; journal "automatic checks off". |
| Isolation | The installer stops only `protocol-qa.exe` and writes only the QA uninstall key and `HKCU\Software\vmedvedevpro\Protocol QA`. After the uninstall the HKCU registry snapshot (uninstall entries, Software keys, Meetily and Protocol keys, AUMIDs, shortcuts) matched the one taken before the first install; the owner's Protocol and Meetily folders did not change. |

The run found two defects, fixed on this branch and verified in 0.3.3: a quit
refused during an import named only "the speech engine is busy" (the import
holds the engine lock), and a failed manual check was invisible while an update
was offered.

### CI

`updater-e2e.yml` passed on all three platforms on 2026-10-26 (run
40251084286): each relaunched build reported
`{"from":"9.0.0","outcome":"updated","version":"9.0.1"}`, with the Windows
file version, the macOS `Info.plist` and the Linux AppImage replaced. On
Windows the installer relaunched the app itself (no fallback start). An
earlier run had timed out on Windows while unpacking all of LLVM; the job now
extracts only libclang (about 15 s).

## Limits

- The first real proof is the step from the first updater release to the next;
  until then the end-to-end runs above are the evidence.
- No channels (beta), no delta updates, no rollback beyond reinstalling.
- macOS permissions may be asked again after an update (ad-hoc signature, no
  signing identity yet). Windows installers are not Authenticode-signed; the
  minisign signature is what authenticates the payload.
- A Windows install exits the process from inside the plugin; anything that
  `RunEvent::Exit` does and `prepare_exit` does not is skipped.
- Work only the WebView knows about is covered by a lease that expires after
  150 seconds without a report.
