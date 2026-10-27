# Privacy Policy — Protocol

**Short version: your meetings stay on your machine unless you explicitly choose
to send them to a cloud provider or submit a crash report. The only automatic
network requests are a daily check for a new release and a new model list on
this project's GitHub page, and for changes to your downloaded models on
Hugging Face, which you can turn off. Showing a list of models also asks
Hugging Face for the download sizes of the models it offers.**

## What is collected

Protocol has **no analytics, telemetry, or usage tracking**. There is no
account and no sign-in. The app never sends your audio, transcripts, summaries,
crash reports, or usage data to the author or anyone else. Its only automatic
network requests are the [update checks](#update-checks), which carry no
information about you or your meetings.

Earlier versions kept a local file, `analytics.json`, with the total number of
meetings, the date and time of the last one, a count of meetings per day, and
the analytics opt-in flags (always off). The file never leaves your machine, and
the current version neither reads nor writes it, but a copy left by an earlier
version may still be on disk (see [Your control](#your-control)).

## Where your data lives

- **Audio recordings, transcripts, summaries, and settings** are stored **locally**
  on your device (a SQLite database and files in the app's data and recordings
  folders).
- **API keys** you enter (if you choose a cloud AI or transcription provider) are
  stored locally, unencrypted, and used only to talk directly to that provider.

## When data leaves your machine

Data leaves your machine only when **you** choose an action that sends it:

- If you select a **cloud AI provider** (Claude, OpenAI, Groq, OpenRouter, or a
  custom endpoint), the transcript text you summarize or ask about is sent to
  that provider under **your** account, subject to **their** privacy policy and
  data-retention terms.
- If you select a **cloud transcription provider**, your audio is sent to that
  provider.
- **Model downloads**, including **Re-download models** for the bundled speaker
  models, contact Hugging Face (`huggingface.co` and the Hugging Face download
  servers it redirects to). These requests carry no meeting content.
- **Update checks** (automatic unless you turn them off) read release
  information and the model list from GitHub and the versions of your
  downloaded models from Hugging Face, and an update downloads only when you
  click **Download** or **Update**. They upload nothing.
- **Model sizes.** A list of models (Settings, onboarding, the optional
  downloads) asks Hugging Face for the file sizes of the models it offers when
  it does not know them yet. These requests carry no meeting content.

If Protocol detects that the previous session ended unexpectedly, it can create
a redacted crash-report ZIP at your request. The report excludes recordings,
transcripts, summaries, meeting names, the database, settings, credentials,
usernames, hostnames, and device names. It contains crash type/time, app version
and backend, OS family and major version, architecture, bucketed CPU core count,
rounded memory size, and a source-relative panic file/line location with a
location fingerprint when available. Choosing **Send Report** saves the ZIP
locally and opens a public GitHub issue form in this repository. Opening GitHub
sends normal request data to GitHub. The ZIP remains local until you attach it;
GitHub uploads attachments before the issue is submitted.

Using the **built-in local model**, **local Whisper/Parakeet**, and **Ollama**
keeps meeting content on your device.

## Update checks

Protocol updates itself from this project's GitHub releases.

- **What it requests.** About once a day, and whenever you click **Check for
  updates**, Protocol downloads a small file, `latest.json`, from
  `https://github.com/vmedvedevpro/Protocol/releases/latest/download/latest.json`.
  It lists the newest published version, its release notes and its download
  links. If that version is newer, Protocol shows **Update available**.
- **What it downloads.** Nothing more until you click **Download**. Protocol
  then fetches the installer for your system from the same release and checks
  its signature before keeping it. It does not download while a recording runs.
- **What GitHub receives.** An ordinary HTTPS request: your IP address, the
  time, and the user agent `tauri-plugin-updater/<version>`. The request does
  not contain Protocol's version, an installation ID, your settings, or
  anything about your meetings. Downloading an update shows GitHub which
  system's installer you fetched. GitHub handles this data under the
  [GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- **What it never does.** It never uploads anything, and nothing installs until
  you choose **Restart and update** or quit Protocol, never during a recording
  or while a meeting is being processed.
- **Models.** With the same daily check, and whenever you click **Check for
  model updates**, Protocol reads the list of models it offers,
  `model-catalog/catalog.json`, from
  `https://raw.githubusercontent.com/vmedvedevpro/Protocol/main/model-catalog/catalog.json`,
  and asks Hugging Face (`huggingface.co/api/models/…`) for the current
  version and file list of each model you have downloaded, to see whether it
  changed, and again for the file sizes of the model repositories a list
  showed before. Showing a list of models (Settings › Transcription and
  Summaries, onboarding, the optional downloads) asks Hugging Face once for the
  current version and file list of the repositories of the models it offers,
  to show their download sizes; this happens when the list is shown, also with
  the automatic check off, and not again once the sizes are known. These
  requests send your IP address, the time, the user agent
  `Protocol/<version>` and, to Hugging Face, the names of the model
  repositories asked about; nothing about you or your meetings.
  A model update downloads only when you click **Update** on its card.
  GitHub and Hugging Face handle this data under their own privacy policies.
- **Turning it off.** Settings › About › **Check for app and model updates
  automatically**. With it off, Protocol contacts GitHub and Hugging Face for
  updates only when you click **Check for updates** or **Check for model
  updates**; a model list shown for the first time still asks Hugging Face for
  its sizes. Copies installed from the `.deb` package check the same way but
  only show a link to the new version.

## Your control

Delete a meeting in the app and its data is removed locally. Uninstalling the app
and deleting its data and recordings folders removes everything.

A downloaded update is kept in the app's cache folder (`updates`) until it is
installed or replaced by a newer one. The last model list, the results of the
model checks and the model sizes read from Hugging Face are kept in the same
cache folder (`model-catalog`). That folder also holds `updater.log`, a
short local record of checks, downloads and installs with versions and error
messages, which you can attach to a bug report. Neither leaves your machine.

Deleting meetings does not change the counts in a leftover `analytics.json`. On
Windows the file is `%APPDATA%\io.github.vmedvedevpro.protocol\analytics.json`;
on macOS it is in `~/Library/Application Support/io.github.vmedvedevpro.protocol/`.
Nothing in the app uses it, so you can delete it safely at any time.

## Contact

Protocol is an open-source project. For questions or problems, open an issue at
<https://github.com/vmedvedevpro/Protocol/issues>.
