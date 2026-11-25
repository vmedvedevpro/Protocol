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
  for Windows, macOS (Apple Silicon) or Linux.
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
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/search-to-line-dark.gif">
    <img src="docs/media/search-to-line-light.gif" alt="Ctrl K search for &quot;retention&quot; finds an action item, a line said in a meeting and a summary; choosing the line opens the meeting's transcript at 35:29 with that line highlighted and the player at the same time" width="400">
  </picture>
</p>

## Changes from Meetily – Actually Free

- A new compact interface, written from scratch for 1.0.
- Live transcription is 2.5 times faster than in Actually Free.
- Transcription after a call is 5 times faster than in Actually Free.
- Transcription after a call makes 20 % fewer word errors.
- On Intel GPUs under Windows, Whisper runs through OpenVINO and is another 4 times faster.
- On Intel NPUs, Parakeet uses 3.5 times less energy than on the processor.
- AI agents can read your meetings through MCP.
- The analytics code is removed.
- Updates are built into the app.
- Transcription and summary models are verified before they load. New models arrive without a new Protocol release.
- Installers for Windows, macOS and Linux are built from the tagged source in public GitHub Actions runs.
- Actually Free builds its Windows installer on its maintainer's computer.
- Each release carries SHA-256 checksums and signed build provenance.

The speed and energy figures were measured on an Intel Core Ultra laptop.

## Privacy

Everything runs on your computer. Your meetings leave it only if you connect
a cloud model or an AI agent. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Credits and license

Protocol is built on [Meetily – Actually Free](https://github.com/TylerBuza/Meetily-ActuallyFree)
by Tyler Buza and the original [Meetily](https://github.com/Zackriya-Solutions/meetily)
by Zackriya Solutions, both MIT licensed. To build it yourself, see
[docs/BUILDING.md](docs/BUILDING.md).

MIT licensed; see [LICENSE.md](LICENSE.md).
