# Measuring transcription

How to measure a change to transcription or speaker labels before it merges:
which numbers to take, how references are built, how to time, and how to read
the results. The kit has three parts:

- **Commands in Rust** (`frontend/src-tauri/src/measure/`): ignored tests that
  run the product's own code on a recording and write JSON. The post-meeting
  settings go through the functions retranscription and import call
  (`audio/post_meeting.rs`): the batch VAD with each engine's cap, the pieces
  in time order with the 25 s cut, and the loop over them (`Pass`: the skip
  rule, the per-track language on Auto, the engine call, the
  silence-hallucination filter). The live setting makes the live worker's
  call after its skip rule, the reference the pass's Whisper call without
  timestamps, and the speakers come from `diarize_meeting`'s timeline merge
  and row labelling. A change to any of these reaches the kit. What the kit
  does itself: it reads the tracks as retranscription does (the same source
  finder and decoder, not the same function), runs the settings one after
  another with a warm-up call, keeps the pieces of a span, and writes what
  the pass would store instead of storing it. `cargo test` builds the
  commands and never runs them; CI does not either.
- **Scoring in Python** (`scripts/measure/`): normalisation, alignment and the
  metrics below, printed as Markdown tables.
- **A public fixture**: Russian and English speech with human transcripts,
  fetched by a script, so results can be reproduced without a private
  recording.

The method comes from #62, which found why the post-meeting pass lost words
only by measuring it; its report numbers are quoted below as examples.

## Which changes must be measured

Measure before merging any change to:

- the VAD: thresholds, redemption time, the continuous-speech cap, the 25 s
  cut, the skip rule;
- Whisper decoding: strategy, beam width, temperature, thresholds, timestamps,
  the prompt, the language detection;
- how pieces become rows (`audio/post_meeting.rs`), and anything that changes
  what retranscription or import stores;
- Parakeet: the model, its pieces, its decoding;
- speaker labelling: diarization engines, their parameters, the row labelling;
- a runtime or model update: whisper.cpp or whisper-rs, ONNX Runtime or `ort`,
  a GPU backend, a new model file.

Compare the change against `main` on the same audio (see
[Comparing two builds](#comparing-two-builds)), on the public fixture and, for
changes aimed at meetings, on a recorded meeting. A change that is meant to
leave text unchanged (a runtime update) should show identical rows; say so
with the count of identical pieces.

## Setup

- **Rust**: the toolchain of [BUILDING.md](BUILDING.md#build-from-source-windows).
  Measure a release build with the backend you care about; a Vulkan build on
  Windows needs a short target dir (`$env:CARGO_TARGET_DIR = 'C:\t'`). The
  commands do not need the frontend, so build without `custom-protocol`.
- **Python 3.12** and the pinned scoring packages, once, from the repository
  root:

  ```powershell
  py -3.12 -m venv .measure\venv
  .measure\venv\Scripts\python -m pip install -r scripts\measure\requirements.txt
  ```

  The scoring's tests: `.measure\venv\Scripts\python -m unittest discover -s scripts\measure`.
- **The fixture**: `.measure\venv\Scripts\python scripts\measure\measure.py fetch-fixture`
  (about 360 MB of downloads; see [The public fixture](#the-public-fixture)).
- **Models** are read in place and never written to: the app's own copies in
  `%LOCALAPPDATA%\vmedvedevpro\Protocol\data\models` (the Whisper `.bin`, the
  Parakeet folder, `diarization\nemotron3_diar_v3.onnx`), or the Pyannote
  models in `frontend/src-tauri/resources/diarization`. A model reference
  needs Large V3 in f16: `ggml-large-v3.bin`, 3,095,033,483 bytes, SHA-256
  `64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2`, from
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3.bin`.

`.measure/` is git-ignored; it holds the venv, the downloads, the fixtures and
the outputs of fixture runs. A relative path in a `MEASURE_*` variable is taken
from the repository root.

The Labs switches are read from the app's data folder. On Windows and Linux
that is, for a test binary, an empty `data/` beside it
(`target\release\deps\data`), so they are off, as on a new install. To measure
one on, write `true` into `whisper_strict_silence.txt` or
`parakeet_gpu_enabled.txt` there. On macOS the data folder is the installed
app's own, so a run takes the switches set in the app. Each run records both
(`whisper_strict_silence`, and Parakeet's `acceleration`).

## The commands

### `measure::transcribe_settings`

Runs the compared settings on one recording, one after the other in one
process, and writes `<setting>.json` per setting (every piece with its time,
whether it was skipped or dropped, its Whisper decoding, its rows, and each
row's speakers) and, with diarization, `diarization.json`. Settings with the
same VAD cap (`live` and `parakeet`) share one VAD pass.

| Variable | Meaning |
| --- | --- |
| `MEASURE_AUDIO` | An audio file, or a recording folder (`mic.mp4` and `system.mp4` are read as two tracks, as retranscription reads them; otherwise its audio file as one track). Required. |
| `MEASURE_OUT` | The folder for the JSON. Required; created if missing. |
| `MEASURE_SETTINGS` | Comma-separated, in order: `post-meeting` (the Whisper post-meeting pass: pieces from pause to pause, rows from Whisper's segments), `live` (the live Whisper call, greedy without timestamps, on the batch VAD's capped pieces of at most 6 s, one row per piece; like the live worker it skips only digital silence and keeps every text), `parakeet` (the Parakeet post-meeting pass: capped pieces, one row each). Default `post-meeting,live`. |
| `MEASURE_WHISPER_MODEL` | The ggml file for the Whisper settings. |
| `MEASURE_PARAKEET_MODEL` | The Parakeet model folder for `parakeet`. |
| `MEASURE_LANGUAGE` | The app's language setting: `ru`, `en`, …, or `auto` (default). On `auto` the post-meeting pass detects the language once per track, from the pieces of the whole recording also with a span; live calls detect it per call. |
| `MEASURE_VOCABULARY` | The vocabulary the app would pass (Settings › Transcription). Optional. |
| `MEASURE_SPAN` | Only the pieces that reach into `start-end`, as `25:00-45:00` or `1500-2700` (seconds), each transcribed whole; the scoring then keeps the words inside the span, by word time, of both the runs and the reference. The VAD, the language detection and diarization read the whole tracks, as the app does, so the pieces and the timeline are those of the whole recording. A span that starts after the recording ends is refused; its end is cut to the recording's. Optional. |
| `MEASURE_DIARIZATION`, `MEASURE_DIARIZATION_MODEL` | `nemotron` with the `.onnx` file, or `pyannote` with the model folder: diarize the recording as `diarize_meeting` does, with the app's default parameters, and label every row on that timeline. A microphone and a system track are each diarized whole and merged, the microphone's speech as speaker 0 and the system track's speakers after it (`merge_tracks`); a single track is diarized alone. Pyannote reads a WAV of each track, which the kit writes under `MEASURE_OUT` while it runs. Optional. |

### `measure::build_reference`

Writes `reference.json` with Large V3 (`MEASURE_REFERENCE_MODEL`); it reads
`MEASURE_AUDIO`, `MEASURE_OUT`, `MEASURE_LANGUAGE`, `MEASURE_VOCABULARY` and
`MEASURE_SPAN` like the command above, and refuses to overwrite a reference.
Give it the language and vocabulary of the settings it will score. See
[References](#references) for the method.

### Scoring

```powershell
.measure\venv\Scripts\python scripts\measure\measure.py score <run folder>\post-meeting.json <run folder>\live.json --reference <reference.json> --diarization <run folder>\diarization.json --out <scores.json>
.measure\venv\Scripts\python scripts\measure\measure.py spotcheck <run folder>\post-meeting.json <run folder>\live.json --reference <reference.json> --out <spotcheck.md>
```

`score` prints the summary table and where the missing words were; `--out`
also writes every number as JSON, the rates included. It refuses a reference
whose tracks or span do not match the run's (a reference built from the audio
file scored against a run on the meeting folder, or one built for a smaller
span), and a timeline of other tracks. `spotcheck` prints ten random 25 s
passages of the span (`--passages`, `--seconds`, `--seed`) with each run's
rows and the reference's, to read what the numbers count; runs are named as
in `score`.

Each piece records its Whisper decoding, `beam 5` or `greedy`. The
post-meeting pass turns greedy for the rest of the process when the GPU has
no room for the beam's KV cache (`whisper_engine/post_meeting.rs`), so `score`
warns when a run's pieces were decoded both ways, or two runs of one setting
differently: such a comparison sets beam search against greedy decoding. The
reference fails instead.

## Comparing two settings

The documented comparison on the Russian fixture, from the repository root
(PowerShell; on Linux and macOS set the same variables and drop the target
dir and `--features vulkan` as your build needs):

```powershell
$env:CARGO_TARGET_DIR = 'C:\t'
$models = "$env:LOCALAPPDATA\vmedvedevpro\Protocol\data\models"
$env:MEASURE_AUDIO = '.measure\fixtures\fleurs-ru\audio.wav'
$env:MEASURE_OUT = '.measure\runs\fleurs-ru'
$env:MEASURE_LANGUAGE = 'ru'
$env:MEASURE_SETTINGS = 'post-meeting,live'
$env:MEASURE_WHISPER_MODEL = "$models\ggml-large-v3-turbo-q5_0.bin"
$env:MEASURE_DIARIZATION = 'nemotron'
$env:MEASURE_DIARIZATION_MODEL = "$models\diarization\nemotron3_diar_v3.onnx"
cargo test --release -p protocol --no-default-features --features vulkan --lib measure::transcribe_settings -- --ignored --exact --nocapture

.measure\venv\Scripts\python scripts\measure\measure.py score .measure\runs\fleurs-ru\post-meeting.json .measure\runs\fleurs-ru\live.json --reference .measure\fixtures\fleurs-ru\reference.json --diarization .measure\runs\fleurs-ru\diarization.json
```

For English, use `fleurs-en` and `MEASURE_LANGUAGE = 'en'`. Add `parakeet` to
`MEASURE_SETTINGS` with `MEASURE_PARAKEET_MODEL` to include Parakeet.

### Comparing two builds

For `main` against a branch, build each (a second worktree for `main`), run
the same command with the same inputs and a different `MEASURE_OUT`, then
score both runs together; runs of the same setting are labelled by their
folder:

```powershell
.measure\venv\Scripts\python scripts\measure\measure.py score main\post-meeting.json branch\post-meeting.json --reference .measure\fixtures\fleurs-ru\reference.json
```

Two builds run in two processes, so their times compare only under the
[timing protocol](#timing) and with repeats.

## What the numbers mean, and when they mislead

All text metrics work on normalised text: Unicode NFKC (a letter typed as a
base and a combining mark equals the composed one), lower case, `ё` as `е`,
every punctuation mark, symbol and space as one space (`кто-то` and `don't`
are two words on both sides). Digits stay as written, so `25` against `двадцать пять`
is an error: the engines write numbers both ways, and spelling them out would
need a rule per language. Each track is aligned on its own (its rows in time
order) and the counts are pooled, so a rate is all edits over all reference
words.

| Number | What it is | When it misleads |
| --- | --- | --- |
| WER, S/D/I | Word edits against the reference (jiwer's minimum edit distance): substitutions, deletions (reference words missing from the output), insertions; over reference words. | The reference's own errors count against the output; a model reference favours output in its own style (Whisper's punctuation and spelling, not Parakeet's). Numbers, names and spelling variants count as errors. The same WER can hide fewer deletions and more substitutions: read S/D/I. |
| CER | The same over characters (spaces included). | Kinder to Russian endings than WER; inflated by numbers written differently. |
| Lost stretches | Runs of 5 or more consecutive reference words that the output does not have: speech lost, not misheard. The table counts them; the second table lists the largest with their time. | Their times are spread evenly over a reference row, so they are only as precise as the rows are short (a sentence for the fixture, one VAD utterance for a model reference). |
| Missing words by place | Each deleted reference word placed outside every kept piece (the VAD missed it, or the pass skipped or dropped its piece), within 2 s of a piece's start or end (where cuts inside speech lose words), or inside a piece. | Same time precision. A model reference decoded on the same pieces cannot show VAD losses; a human transcript can. |
| ≥ 3 s → ≤ 2 words | Transcribed pieces of at least 3 s that came back with at most two words: the signature of a decode that ended early (#62). | A long piece of noise, or a lone "Да." with a long pause, counts too. |
| Loops | Pieces whose text repeats a 1–4-word phrase back to back (one word 4 times, a longer phrase 3 times), after the product's own repetition cleanup. | Genuine repetition (a microphone check, a count) counts too. |
| Rows with hallucinations | Rows the run keeps that contain a phrase Whisper writes over silence or noise: Russian subtitle credits (`субтитры`, `корректор`, `DimaTorzok`, …), `продолжение следует`, `спасибо за просмотр`, `thanks for watching`, `like and subscribe`, a row that is only "you". | Speech that really says these words counts too. Dropped pieces (the retranscription loop's quiet "you" / "thank you" filter) are not counted; the JSON has their number. |
| Speaker agreement | Over 100 ms slices of the span where exactly one speaker talks on the timeline: of the slices inside a row of that speaker's track (the microphone's for the user, speaker 0 on two tracks), the share whose row has that speaker as its main one. | The timeline is the reference: it measures what the rows cost the labelling, not whether diarization is right. On two tracks a system row the user talks over can get the user as its main speaker, as in the app, and counts against the remote speaker's slices. |
| Rows with a turn change | Rows in which another speaker of the row's own track talks for 0.5 s or more, against the row's main speaker. | Diarization jitter shorter than that is ignored; a row the app labels "A + B" still counts. A remote speaker over a microphone row is crosstalk, not counted. |
| time s, × real time | The transcription calls plus the language detection, summed, and the audio given to the calls over that time. | The VAD is reported apart (`vad_ms` in the JSON), since it reads whole tracks even for a span; settings that share a VAD pass report its time each. A span's pieces reach past it, so the audio and time are those of whole pieces. Noise up to about 10 % between runs (see [Timing](#timing)). |
| Reference repeats | Reference words that repeat what was just said (a 3–25-word phrase twice in a row, a pair three times, a word four times), printed above the table. | A health check: natural speech has few; many mean a long-form artefact. |

## References

- **A human transcript is the reference** when there is one, as in the
  fixture. The scoring reads `{"rows": [{"start_ms", "end_ms", "text"}, …]}`
  (with `"track"` when the recording has two).
- **A model reference is needed** for a recorded meeting, which has no
  transcript, and for a span of speech that a human transcript does not time.
  `build_reference` follows #62's REF-u method: Large V3 in f16, one call per
  VAD utterance (the post-meeting pass's pieces from pause to pause, up to
  about 28 s), beam search 5 at temperature 0 with the app's thresholds and
  the vocabulary, without timestamps. Large V3 because Large V3 Turbo, without
  timestamps, puts its probability on end-of-text 12–25 s into a window while
  the speech goes on (21 of 34 windows in #62; Large V3: 4, each in the last
  words); one utterance per call because a call then holds one stretch of
  speech and no timestamps are needed to resume. The call shares the pass's
  parameters, prompt and state handling (`WhisperEngine::reference_text`) but
  not its repetition cleanup, so that the reference's own repeats show in the
  health line.
- **Not long-form decoding.** #62's first reference decoded each whole track
  with timestamps: 47 % of its 4,056 words were repeated phrases in
  zero-length segments, which every candidate then "deleted". The per-utterance
  reference had 6 repeats in 1,981 words. The score prints the reference's
  repeats so that this shows at once.
- What a model reference cannot see: speech its VAD pieces miss, and its own
  errors (Large V3 is better than Turbo, not right). It shares the
  post-meeting pass's pieces, so it favours no cut, but it does favour
  Whisper's style over Parakeet's. Spot-check before trusting a small
  difference.

## Timing

- Run the compared settings in one process: `transcribe_settings` runs them
  in the order given, on the same loaded model. Each setting decodes its first
  piece that is not skipped once untimed before its timed loop (the first call
  pays the GPU's set-up; a beam search's first call its cache shapes).
- Measure a release build with the backend you measure; the output records
  whether the build was optimized, and the score warns about a debug run.
- Keep the GPU otherwise idle (close the app, or check that it is idle: the
  GPU's 3D engine under 10 % before and after) and run one heavy process at a
  time: no build, no second measurement, no other model.
- Expect noise: identical decodes differed by up to 10 % between batches on
  an Intel Arc iGPU in #62. Treat a time difference under 10 % as noise unless
  repeats confirm it: run again with the settings in the other order
  (`MEASURE_SETTINGS = 'live,post-meeting'`).
- Report the speech duration with the time (both are in the table), so a
  change in what the VAD keeps is not read as speed.

## Measuring a private recording

A recording and every transcript made from it are private. The kit reads the
recording in place and writes only to `MEASURE_OUT`, which with Pyannote also
holds a WAV of the track being diarized while it runs (left there if the
process is killed):

- point `MEASURE_AUDIO` at the meeting folder in the recordings folder; it is
  only read;
- set `MEASURE_OUT` outside the repository (or under the git-ignored
  `.measure/`), and never commit, upload or paste its JSON, scores JSON or
  spot checks: they hold the transcript. Pull requests and issues get the
  numbers only;
- set the vocabulary in the shell, not in a file in the repository;
- build the reference once per recording and span (`build_reference`, with
  the same `MEASURE_SPAN`; Large V3 takes about 4 s per utterance on an Intel
  Arc iGPU), keep it beside the runs and reuse it;
- `MEASURE_SPAN` keeps a long meeting's runs short; #62 measured 20 minutes.

## The public fixture

`measure.py fetch-fixture` builds `.measure/fixtures/fleurs-ru` and
`fleurs-en`, each an `audio.wav` (16 kHz mono) and a `reference.json`:

- **Source**: [FLEURS](https://huggingface.co/datasets/google/fleurs)
  (Conneau et al., 2022), Google, **CC BY 4.0**: read Wikipedia sentences with
  their human transcripts. The dev split of `ru_ru` and `en_us`, pinned to
  dataset commit `70bb2e84b976b7e960aa89f1c648e09c59f894dd` with each file's
  size and SHA-256 (`scripts/measure/kit/fixture.py`); about 360 MB of
  downloads, cached in `.measure/cache`.
- **Assembly**: 24 readings of distinct sentences, alternating a woman's and
  a man's voice: for each in turn, the first reading in the transcript file by
  that voice of a sentence not chosen yet (FLEURS names a reader's gender, not
  the reader). Each sentence is scaled to a peak of 0.5 (−6 dBFS): FLEURS
  recorded its readers at very different gains, and half of the English
  sentences peak below 0.021, some at 0.004, under the post-meeting pass's
  silence rule (`skip_reason`: peak under 0.01) and far below a meeting's
  levels. Each is then cut to its speech, from the first to the last 10 ms
  with an RMS at most 34 dB under the peak, with 0.1 s around: FLEURS clips
  carry their own silence, often more than a second at each end, which with
  the gap would outlast the VAD's redemption time. Groups of three sentences
  with 0.6 s between them, shorter than the batch VAD's 2 s redemption time,
  so a group is mostly one piece of 25–34 s with changes of voice inside; 3 s
  between groups, so pieces end there. On Russian the VAD finds five segments
  over 25 s and the pass cuts three (it keeps the other two whole: their
  quietest point lies in the last 2 s); on English, where the VAD ends a few
  pieces inside a group, two and one. Russian 258 s, English 239 s. The
  assembled audio is checked against a pinned SHA-256 before it is written.
- **Reference**: FLEURS's transcriptions, each timed from its cut sentence's
  start to its end in the layout.
- **Limits**: read speech in quiet rooms, no overlapping speakers, no
  meeting vocabulary; neighbouring sentences come from different readers, so
  the diarization finds more than two voices. Use it to reproduce and to
  compare, and confirm a change aimed at meetings on a recorded meeting.

## Known limits of the kit

- `live` reproduces the live call and pieces of live size, not the live
  pipeline (its own VAD while recording, the queue, the GPU shared with
  capture).
- The pass is retranscription's: the import reads a file as one track with
  the same VAD values, but detects the language once for the file and has no
  silence-hallucination filter.
- Diarization runs with the app's default parameters, not the ones a user
  saved, and leaves the user's voiceprint alone (the app updates it from the
  microphone track).
- Diarization reads the kit's decoding of each track. The app gives Pyannote
  ffmpeg's 16 kHz 16-bit WAV of an `.mp4` instead (`ensure_wav`), and Nemotron
  that WAV read back: another resampler, so turn boundaries can move slightly.
  The kit does not call `ensure_wav`, which needs ffmpeg beside the app and
  writes the WAV to the OS temp folder. The size of the difference is not
  measured.
- On macOS the Labs switches are the installed app's (see [Setup](#setup)).
