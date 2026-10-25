# Privacy Policy — Protocol

**Short version: your data stays on your machine unless you explicitly choose to
send it to a cloud provider or submit a crash report.**

## What is collected

Protocol has **no automatic analytics, telemetry, update checks, or other
phone-home behavior**. There is no account, no sign-in, and no usage tracking.
The app does not automatically send your audio, transcripts, summaries, crash
reports, or usage data to the author or anyone else.

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
- **Model downloads** contact Hugging Face and, for some models, GitHub release
  pages. These requests carry no meeting content.

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

## Your control

Delete a meeting in the app and its data is removed locally. Uninstalling the app
and deleting its data and recordings folders removes everything.

Deleting meetings does not change the counts in a leftover `analytics.json`. On
Windows the file is `%APPDATA%\io.github.vmedvedevpro.protocol\analytics.json`;
on macOS it is in `~/Library/Application Support/io.github.vmedvedevpro.protocol/`.
Nothing in the app uses it, so you can delete it safely at any time.

## Contact

Protocol is an open-source project. For questions or problems, open an issue at
<https://github.com/vmedvedevpro/Protocol/issues>.
