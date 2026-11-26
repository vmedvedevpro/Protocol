# Speech check (#233)

Settings › Advanced › Speech check runs every speech engine Protocol has on a
short known sample, each on the device Protocol picks on this computer, and
writes a report a tester pastes into a chat. It answers two questions about a
computer the developers cannot test themselves: did Protocol pick the right
device for each model, and does each model run on it without errors. It is not
a benchmark: it records timings so that a model that runs but crawls shows, and
compares nothing.

## Who owns what

| Owner | Role |
| --- | --- |
| `frontend/src/api/speechCheck.ts` | The pair the check runs (`checkPair`, the rule of For this computer: Parakeet v3 live, the Intel GPU version where `gpuOffered`, else the Compressed copy), the inputs of that choice, the selected models, the commands and `speech-check-changed`, Save report. |
| `features/settings/components/speech/SpeechCheckGroup.tsx` | The group: idle, the list with downloads, running with Cancel, the report with Copy and Save, and an interrupted check with Run the remaining steps. `speechCheckText.ts` words devices as Settings does. |
| `src-tauri/src/speech_check/mod.rs` | The commands (`speech_check_status`, `_run`, `_resume`, `_cancel`, `_dismiss`), the status, the run: busy hold, the app's engines taken and given back, the steps in order, the report. |
| `speech_check/steps.rs` | The four steps on engines of their own: picked device, load, ran-on device, fallback, the sample, scores. |
| `speech_check/sample.rs` | `sample::load()`, the only place that knows where the clips come from (the app's resources); checks each file's SHA-256 and decodes it. |
| `speech_check/score.rs` | Word error rate, the speaker score, the thresholds and why. |
| `speech_check/report.rs` | The report's data, its text and JSON, and the scrubbing. |
| `speech_check/note.rs` | The crash note. |
| `speech_check/hardware.rs` | What the report says about the computer. |
| `scripts/measure/kit/speech_check.py` | Builds the clips from FLEURS (`measure.py speech-check-sample`). |

## A run

1. Run check lists the four steps and offers a download for each model that is
   not on the computer, with its size from the catalog (Parakeet v3, the
   Compressed copy or the Intel GPU version with `choose: false`, Nemotron).
   A model left undownloaded is sent as `declined` and reported as not
   checked. Pyannote is built in.
2. `speech_check_run` refuses during a recording, its stop and its save, an
   import, a retranscription, offline diarization, the post-call pass and a
   summary, and while a check runs. Otherwise, in one hold of the status, it
   resets the cancel flags, takes `BusyReason::SpeechCheck` until the report
   is written (so an update never restarts the app in the middle) and emits
   Running, so the group shows "Getting ready" with Cancel at once.
3. Under the engine lifecycle lock it asks again whether a recording
   started, a Cancel came or other work began (a recording started from the
   tray just after Run loads its models under that lock), and if so runs no
   step and leaves the engines alone. Otherwise it notes the models the
   app's Whisper and Parakeet hold and unloads them: a second copy would
   double their memory, and the NPU's `active` flag and OpenVINO's last
   backend outcome are process-wide. It keeps that outcome, and stops the
   builtin LLM (`prepare_for_stt`), as every speech model load does.
4. It reads the computer (`hardware.rs`) and the sample, then runs the steps,
   writing the crash note before each and after each. A step that panics
   fails with its message (`guarded`), and the run goes on.
5. It gives back: unless a recording started meanwhile, it loads back what
   the app's engines held (under the lock) and, when Whisper was not reloaded,
   puts OpenVINO's last outcome back, so Settings' fallback notice is the
   app's, not the check's.

The check writes no setting and no selection, and never touches
`WHISPER_ENGINE` or `PARAKEET_ENGINE` while a step runs. While it runs,
`speech_check::refuse_beside` refuses an import, a retranscription (the
post-call pass's too), speaker identification and a summary on this
computer, with a message that names the check. A Cancel marks only a
running check, in the same hold of the status, so one that arrives after
the finish changes nothing.

## The steps

Each step reads "picked" before its load, from the inputs the engines' own
device rules read, and "ran on" afterwards from the loaded engine. When they
differ the step reports a fallback with the error the app recorded; nothing
falls back silently.

| Step | Runs | Picked from | Ran on from |
| --- | --- | --- | --- |
| Parakeet | `ParakeetEngine::load_model`, then the live path: the pieces the live VAD cuts (`audio::pipeline`'s thresholds 0.20/0.10, redemption 800 ms and a 6 s cap, or 350 ms and 3.5 s with Faster live text) and `transcribe_live` with `chunking::Live`, as the live worker | `npu::state::status()` and `MODEL_ID` (Windows), `labs::enabled`, `overrides_labs` | `uses_npu()`, before and after the clips (the NPU can fail mid-run); the NPU's `reason` as the fallback error |
| Whisper | `WhisperEngine::load_model` of the pair's id (the Intel GPU version's fallback to a regular copy included), then `post_meeting::Pass` with the language detected once and the silence filter | `speech_choice::gpu_version`/`installed`, `installed_companion`, `openvino::availability()` and `stopped()`, `context_parameters`, `whisper_gpu`, `vulkan::stopped()` | `loaded_openvino()`, else `context_parameters` again; `openvino::backend_status().fallback_reason` |
| Pyannote | `diarize_file_with_engine("pyannote")` on a WAV of each clip, as an import | always the processor: its sessions use ONNX Runtime's CPU provider on every platform | the processor |
| Nemotron | `diarize_file_with_engine("nemotron")`, with the saved threshold | DirectML adapter 0 on Windows, else the processor | `nemotron::last_session()`, which `sortformer/support.rs` records with the DirectML error after a CPU fallback |

Whisper runs `post_meeting::Pass` directly, not retranscription or the
import, so `speech_choice::after_post_meeting_pass` never runs: a successful
Intel GPU pass in the check does not retire the Compressed copy. Its Vulkan
steps go through the same guard as the app's (`vulkan::load`, `first_run`).

Parakeet keeps up with a meeting when its real-time factor over both clips is
at most 0.5 (`MAX_LIVE_REAL_TIME_FACTOR`): a recording decodes two sources on
one engine.

## The sample

Two clips in `frontend/src-tauri/resources/speech-check/` (bundled on every
platform), with `sample.json` and `THIRD_PARTY_DATA.txt` (the FLEURS
attribution). `ru.flac` 22.6 s (329 KB), `en.flac` 24.6 s (359 KB).

- **Source**: FLEURS dev (`ru_ru`, `en_us`), Google, CC BY 4.0, the kit's
  pinned commit and downloads (`kit/fixture.py`).
- **Two voices**: FLEURS names a reader's gender, not the reader, so two
  readings never certainly share a voice. Each clip takes one woman's reading
  (voice `a`) and one man's (voice `b`), each with one comma, and cuts each at
  the longest pause in its middle half, which falls on the comma: `a1 b1 a2
  b2`, 1.2 s apart: longer than the live VAD's 800 ms redemption, so each
  turn is a live piece of its own, and under the batch VAD's 2 s, so a clip
  is one post-meeting piece. The words up to the comma are the first turn's
  text.
  Russian: `12682213204980623644.wav` (cut at frame 677) and
  `15069537867704390147.wav` (435); English: `9957590450625488532.wav` (351)
  and `10796058897134434902.wav` (813).
- **Pins**: the split frames and the SHA-256 of each clip's 16-bit PCM are in
  `speech_check.py`; FLAC is lossless but its bytes depend on the encoder, so
  `sample.json` records each written file's SHA-256 and `sample::load` checks
  it.

`measure.py speech-check-sample` rebuilds them (ffmpeg encodes the FLAC) into
`.measure/speech-check/`; copy the three files into the resources.

## Scores

Text is compared as the kit compares it (`score::normalize`, `kit/text.py`
without NFKC). Pass thresholds flag broken output, not quality:

- **Word error rate at most 0.5** (`MAX_WORD_ERROR_RATE`). Measured on this
  sample: see the table below. Empty output scores 1.0, another language
  about 1.0, a repetition loop over 1.0, noise near 1.0.
- **At least 75 % of the labelled speech given to the right voice**
  (`MIN_SPEAKER_SHARE`), each found speaker standing for at most one voice,
  counting only what the model labels inside the turns: the pauses within a
  reading, which no model labels, cost nothing. One speaker everywhere scores
  the longer voice's part (at most 0.62 here).
- Each speaker's overlapping spans are merged first (Nemotron's windows
  overlap), and the coverage counts the time any speaker labelled once.
- **At least half of the turns labelled** (`MIN_SPEAKER_COVERAGE`), so a model
  that misses whole turns fails although what it labels is right. The turns
  run from a reading's first word to its last; working models label 78 to
  87 % of them, the rest being pauses and a quiet lead-in.
  The number of speakers found is reported, not scored on its own.

## The report

Plain text, then the same data as JSON (`report::FORMAT` 1): Protocol's
version and package (deb, rpm, AppImage, NSIS, macOS app, development build)
and how Whisper is built; the OS and version, on Linux the distribution,
`XDG_CURRENT_DESKTOP` and `XDG_SESSION_TYPE`; the processor with AVX2 and
AVX-512, threads, RAM; each GPU (Linux: PCI vendor and device, address,
kernel driver and the module's version where it states one, NVIDIA's;
Windows: the display class's name, vendor and `DriverVersion` of each
present adapter); ggml's Vulkan
device lines, which name the Vulkan driver (`vulkan::device_lines`, kept by a
ggml log callback that still writes everything to stderr; Mesa's version is
not readable without a Vulkan or OpenGL context); Intel's OpenCL driver
(Linux); the NPU and its state (Windows); ONNX Runtime's version and
providers. Then the pair and the selected models (the report says when they
differ; the check still runs the pair), the inputs of the pair's choice, and
per step: the model and its catalog commit, picked device with the inputs,
ran-on device, fallback with its exact error, load time, each clip's time,
real-time factor, text, language, word errors or speaker score, pass or fail,
and where a platform path was never run before (`untested_path`: the check on
Windows and macOS was only compiled; on Linux, Vulkan on a GPU other than
Intel's). Warnings: fallbacks, failures, a selection that differs. The
outcome is passed only when a step ran and passed; a check where every
model was missing or declined says "nothing was checked".

Nothing personal: the check reads only the sample, never a meeting or an
audio device, and adds no host name; `report::scrub` writes the home folder as
`~` (any case and slash on Windows, its 8.3 form too), the login name as
`<user>` where it stands as a word (also as `CHRIST~1`) and the computer's
name as `<computer>`, in every free text of the report. Kinds, statuses and
the outcome are not scrubbed, so a login named "whisper" renames no step. The group shows the whole
report before Copy and Save.

## The crash note

`<data>/speech-check.json`, written whole (temp file and rename) before and
after each step with the plan, the steps done and the step running. A start
that finds a step still running records it among the done steps as
ClosedTheApp and names it in `closedIn`, so a second crash in a resumed run
keeps the first and does not run it again; the group then says
"Protocol closed while checking …", shows the partial report, and offers Run
the remaining steps (`speech_check_resume`, the note's own plan, only while
the status is Interrupted) or Run again
(`speech_check_dismiss` first). The step that closed the app is reported, not
run again. A clean quit (`RunEvent::Exit`) is not a crash: `note::set_closing`
removes the note and keeps later writes out. A note left between steps reads
as interrupted with no step named.

The engines' own crash markers do their part at the same start: after a crash
in a Whisper GPU step the Vulkan guard (#176) keeps Whisper on the processor,
so a resumed or later check reports "picked: processor" with the guard's
sentence as the reason; Try again stays in For this computer. OpenVINO's and
the NPU's guards work the same way.

## Recording

Run is off while a recording starts, runs or saves (`useRecordingBusy`), and
native refuses it. A recording's start calls `cancel_for_recording` before it
takes the engine lifecycle lock: the check stops at the next piece, reports
the rest cancelled ("A recording started"), and gives nothing back to the
recording's engines. The start waits up to five seconds (`RECORDING_WAIT`)
for the step in flight to drop its engines: the longest unit a step does
not interrupt is one clip through a speaker engine, about 2 s here; after
that the recording goes on beside the check's engines. A quit during a
check asks first ("the speech check is running"), as for other work.

## Tests

- Native (`cargo test -p protocol --lib speech_check`): `score::tests` (word
  errors, broken output, the speaker share with a split voice, one speaker,
  late boundaries, pauses inside a turn, too little labelled, keeping up), `report::tests` (text and JSON round trip,
  scrubbing of home, Windows profiles, 8.3 names, the user and computer
  names and every free text, a login named like a step, the outcome with
  nothing checked, the selection note), `note::tests` (a step that closed the app, a clean quit, an
  unreadable note, a second crash in a resumed run), `sample::tests` (a damaged, missing or escaping clip; the
  bundled sample decodes to its turns), `steps::tests`, `mod.rs` tests (an
  interrupted run, a recording's cancel and its bounded wait, a recording
  that started after Run, a cancel after the finish or before the next step,
  a start that resets the flags and shows Running, a step that panics, only
  an interrupted check resuming, the refusals both ways, the plan),
  `vulkan::linux::tests::only_ggml_vulkan_device_lines_are_kept`.
- Ignored, with installed models in the test binary's `data/models`:
  `speech_check::tests::every_engine_runs_the_sample_on_the_installed_models`
  prints the whole report (`--ignored --nocapture`; `SPEECH_CHECK_WHISPER`
  picks the Whisper model).
- Frontend: `SpeechCheckGroup.test.tsx` (idle and off during a recording, the
  list with downloads, a run with a declined model and the report, Save,
  running and Cancel, a failure with its reason, resumed after a crash, device
  words, Start only once the inputs of the choice have loaded, nothing
  checked in a live region). Stories: `Settings/Speech check`.
- `scripts/measure/tests/test_speech_check.py`: the text split and the cut.

## Measured on this laptop

Core Ultra X7 358H, Intel Arc B390 (Mesa Vulkan), Kubuntu 26.10.

The ignored end-to-end test (debug build, so the processor steps are slower
than in a release), 2026-11-26, on the clips with 1.2 s between turns:

| Step | Device | Russian | English |
| --- | --- | --- | --- |
| Parakeet v3 int8, live | processor | WER 0.000, RTF 0.03 | WER 0.000, RTF 0.03 |
| Whisper Large V3 Turbo, Intel GPU version | OpenVINO GPU | WER 0.000, RTF 0.04 | WER 0.000, RTF 0.02 |
| Whisper Large V3 Turbo Compressed | whisper.cpp, Vulkan | WER 0.000, RTF 0.14 | WER 0.000, RTF 0.14 |
| Pyannote and WeSpeaker | processor | 2 of 2 voices, share 1.00, 82 % labelled | 2 of 2, share 1.00, 83 % |
| Nemotron | processor | 2 of 2, share 1.00, 81 % labelled | 2 of 2, share 1.00, 80 % (RTF 0.30 and 0.27) |

With the earlier 0.6 s gaps the live VAD did not end the segment between
the first two English turns, and Parakeet returned nothing for the piece
that joined them (WER 0.271). That is #239, a live-path issue the check
does not test; the gaps now let each turn end on its own. The live VAD
still caps a long turn at 5 s pieces (`capped` in the debug log), as it does
in a meeting.

## Limits

- Windows (DirectML, the Intel NPU, the registry's GPUs) and macOS (Metal)
  were reached only by compiling, on the release dry run; the report says so
  on those platforms. On Linux only an Intel Arc iGPU was run.
- The live step runs the live VAD's settings over the whole clip at once,
  not the live pipeline's frames, queue and per-source workers.
- The NPU's preparation is not waited for: a check during `preparing` runs
  Parakeet on the processor and says why.
- A failure of the NPU or OpenVINO in the check is recorded by the engines as
  the app's own failure would be (the NPU goes `failed`, Settings offers Try
  again): it is the same device failing.
