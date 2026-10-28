# Settings layout and Settings › Transcription

Settings pages share one layout, and Transcription is organized by the step of
a meeting it changes. This note maps the pieces to their owners; the speech
model, download and activation rules they call are documented in
[DEVELOPMENT_MAP.md](DEVELOPMENT_MAP.md) §3–4 and [MODEL_CATALOG.md](MODEL_CATALOG.md).

## Shared layout

| Owner | Role |
| --- | --- |
| `frontend/src/components/settings/SettingsGroup.tsx` | `SettingsGroup` (an uppercase title over one card of rows), `SettingRow` (an icon in a column of its own; beside it the title and description, a control on their right that wraps under them when the row is narrow, and the body below, all on one left edge) and `RowNote` (a status or explanation line). General, Transcription, Summaries, Meeting detection, Local AI and Labs use them. |
| `frontend/src/components/settings/ModelRow.tsx` | One speech model in a list: name, description, size and facts, Recommended and in-use badges, and the one action its status allows (Download, Cancel with progress, Retry, Remove behind a confirmation, Download again). Rows never select a model. |
| `frontend/src/app/settings/page.tsx`, `globals.css` (`.settings-shell`, `.settings-group-card`) | Container queries on the page's own width: below 50rem the section list shrinks to an icon rail (each item keeps `aria-label` and `title`), and below 34rem a row hides its icon (`.setting-row-icon`) so its text and controls keep the card's width. The sidebar can take most of a small window, so the viewport width says little here. |
| `frontend/src/components/ui/select.tsx` | A trigger cuts a long value with an ellipsis (`truncate`) instead of clipping it. |

## Settings › Transcription

`TranscriptSettings.tsx` renders four groups; the Settings page passes
`DiarizationSettings` in as `speakerSettings`, and the recorder's setup dialog
(`app/_components/SettingsModal.tsx`) renders the same component without it.
With no speech model installed the model lists come first.

1. **Speech to text**
   - *During the meeting*: a picker of installed models
     (`installedSpeechModels` in `lib/speech-models.ts`: Parakeet first, never
     Parakeet v2). Saves with `api_save_transcript_config` (`parakeet` or
     `localWhisper`), then `onModelSelect` (the setup dialog closes on it).
     A saved model that is not installed shows as a disabled "(not installed)"
     item and a warning.
   - *After the meeting*: "Same as during the meeting" (`live`) or an installed
     model, saved with `api_save_post_call_transcript_config`. The row shows
     what enhancement will actually run, resolved the way
     `PostCallProcessingWorker`'s `resolveEnhancementModel` resolves it, and
     says when the saved model is missing and another one (or none) is used.
     Without any Whisper model it offers the optional Whisper download
     (`OptionalModelDownloadsContext.startDownload('whisper')`, which enables
     it natively) and shows its progress (`aria-label="Whisper download progress"`).
     When that download finished but could not become the after-meeting model
     (`activation-error`), the row says so with Retry even though the model is
     now on disk, until After the meeting uses it.
   - *Meeting language*: `ConfigContext.selectedLanguage` (localStorage
     `primaryLanguage`, synced with `set_language_preference`), the same value
     the record card's language dialog edits. Disabled while recording.
   - *Faster live text*: `real_time_transcription` in the recording preferences.
2. **Vocabulary**: the global list, saved with `api_save_global_vocabulary`;
   Save is enabled only with unsaved changes.
3. **Speakers** (`DiarizationSettings.tsx`): Pyannote and NVIDIA Nemotron as a
   native radio group (status and actions sit outside each label, so no button
   is nested in another), Nemotron's download and progress, Remove (a
   confirmation, then `uninstall_optional_model`), the speech threshold, and a
   closed *Model files and credits* section that still renders its contents.
4. **Speech models**: `ParakeetModelManager` and `ModelManager` (Whisper).
   The Whisper list shows models on disk and the catalog's recommendation; the
   rest wait behind *N more models*, the basic tier first. Badges say where a
   model is in use (*During meetings*, *After meetings*). A finished download
   still becomes the model for its step: Parakeet while recording, Whisper
   after meetings. Removing the optional Whisper model goes through
   `uninstall_optional_model` (refused during a recording or post-call
   processing; resets every choice that used it); other Whisper models use
   `whisper_delete_corrupted_model`, after which `TranscriptSettings` moves
   *After the meeting* back to `live` and live Whisper to Parakeet.
   Downloading the optional Whisper model from its row (`startModelDownload`)
   starts the same `startDownload('whisper')` job as the offer in *After the
   meeting*, so there is one transfer and native code enables it; Cancel on the
   row returns that job to idle rather than to an error.

`OptionalModelDownloads` is no longer part of Settings; onboarding still shows
it (`activeOnly`). Labs speech options that are on are badged on the step whose
engine they change. The Enhance transcript dialog (`RetranscribeDialog`) uses
the same name as its menu item, and its model picker uses catalog names
(`speechModelLabel`) instead of ids.

## Tests

- `tests/download-progress/settings.test.tsx`: background downloads before and
  after activation, the pickers' saved values, the missing-model warning, the
  language row, which removal path each optional model takes, the Pyannote
  credits and the repair text.
- `tests/model-catalog/whisper-manager.test.tsx`, `parakeet-manager.test.tsx`:
  catalog names, tiers, order, the recommendation, *more models*, installed
  models first, Parakeet v2 marked *No longer offered*, in-use badges.
- `tests/lib/speech-models.test.ts`: names, descriptions, languages and the
  picker list.

## Browser preview

`src/dev/preview/models.ts` serves the speech models in development builds:
the default is onboarding's recommended setup (Parakeet live, Whisper Large V3
Turbo Compressed after meetings), `?models=fresh` has no Whisper and
`?models=none` no speech model, so recording opens the setup dialog. Downloads
report progress like the native ones.

## Limits

- Checked in the browser preview, the frontend tests and a production build,
  not yet in the desktop app on Windows or macOS.
- The pickers list installed models only; downloading happens in the lists
  below them.
- A Whisper model removed outside Settings is noticed when the page next lists
  the models.
