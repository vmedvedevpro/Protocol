<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/ring-dark.gif">
    <img src="docs/media/ring-light.gif" alt="Protocol's ring, a softly glowing violet and blue circle whose edge moves gently as if it hears a voice" width="120">
  </picture>
</p>

<h1 align="center">Protocol</h1>

<p align="center">
  Protocol records your calls, transcribes them on your computer, tells the
  speakers apart and writes a summary.
</p>

<p align="center">
  <a href="https://github.com/vmedvedevpro/Protocol/releases/latest"><strong>Download</strong></a>
  for Windows, macOS (Apple Silicon) or Linux (experimental).
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/home-dark.png">
    <img src="docs/media/home-light.png" alt="Home: the search field, folder chips for Acme Corp, Design Team and Weekly Standup, meetings grouped under Today, Yesterday, This week and Earlier this month, and at the bottom the ring with Ready to record and the Record button" width="400">
  </picture>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/meeting-summary-dark.png">
    <img src="docs/media/meeting-summary-light.png" alt="A saved meeting on its Summary tab: the summary, the decisions, and action items with their owners and due dates, above the recording's player" width="400">
  </picture>
</p>

## What it does

- Records your microphone and your computer's audio.
- Transcribes live during the call and again after it.
- Marks your microphone as You and tells the other voices apart.
- Writes a summary with a local model or a provider you connect.
- Searches all your meetings and transcripts.
- Exports a meeting to PDF, Word, Markdown, text or JSON.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/live-transcript-dark.gif">
    <img src="docs/media/live-transcript-light.gif" alt="Record is pressed on Home; the recording opens, its Transcript tab fills in line by line with You, Speaker 2 and Speaker 3, while the timer runs and the ring at the bottom moves with the voices" width="400">
  </picture>
</p>

## Changes from Meetily – Actually Free

- A new compact interface, written from scratch for 1.0.
- Faster transcription on the GPU and the processor, and Parakeet on Intel NPUs.
- Models and speech runtimes download to each computer and update without a new release.
- An in-app updater that installs only when you choose.
- AI agents such as Claude can read your meetings through MCP.
- Builds for Windows, macOS and Linux (deb and AppImage) from public GitHub Actions runs.

## Privacy

Everything runs on your computer. Your meetings leave it only if you connect
a cloud model or an AI agent. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Credits and license

Protocol is built on [Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree)
by Tyler Buza and the original [Meetily](https://github.com/Zackriya-Solutions/meetily)
by Zackriya Solutions, both MIT licensed. To build it yourself, see
[docs/BUILDING.md](docs/BUILDING.md).

MIT licensed; see [LICENSE.md](LICENSE.md).
