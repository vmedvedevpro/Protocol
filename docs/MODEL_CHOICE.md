# Speech models for this computer (#88)

Protocol recommends one pair of speech models per computer and runs each on
the best device the computer has, so the person picks nothing technical:
Parakeet for live text, on the Intel NPU when there is one (#66), and Whisper
Large V3 Turbo for the transcript after meetings, as its Intel GPU version
when the GPU is an Intel GPU (#79), else as Large V3 Turbo Compressed. The
UI names devices only as "Intel GPU", "Intel NPU" and "the processor"; every
size comes from the catalog through native code.

## Who decides what

| Owner | Role |
| --- | --- |
| `frontend/src/lib/speech-choice.ts` | The pair (`recommendedPair`), the device badge of an installed model (`deviceOf`), when the Intel GPU version counts as fallen back (`gpuFallback`), the update offer (`offerFor`, Not now in `localStorage`), the card's copy. Pure functions. |
| `frontend/src/hooks/useSpeechChoice.ts` | Gathers the inputs: `whisper_get_available_models`, `parakeet_get_available_models`, `get_openvino_availability`, `openvino_status` of the recommended Whisper model, `parakeet_npu_status` (and its event), `get_local_stack_status` (the last fallback reason) and `speech_choice_copy_retires`. A failing command reads as nothing there. `useParakeetNpu` is the NPU state alone (Labs). |
| `frontend/src/components/settings/ForThisComputer.tsx` | Settings › Transcription › Speech models › For this computer (mockups N1, N3, N4, N6, N7). |
| `frontend/src/components/settings/IntelOffer.tsx` | The offer after an update (N2), above Speech to text. |
| `frontend/src/hooks/useIntelLibraries.ts` | Intel's libraries downloaded alone for an NPU (`openvino_runtime_download`): one job per WebView that the card, the offer and onboarding share, with its progress (`openvino-runtime-progress`), Cancel (`openvino_cancel` of `openvino-genai`) and a failure that stays until the next try. A second call while one runs (also one started before a reload) follows it until the NPU leaves `needs_runtime`. |
| `frontend/src/components/settings/IntelGpuDownload.tsx` | Onboarding's progress row for the Intel GPU version, or Intel's libraries on an NPU-only PC. |
| `frontend/src-tauri/src/speech_choice.rs` | The native half: the Intel GPU version as a model of its own, `chosen` (after `openvino_download` with `choose`), the Compressed copy's removal, `speech_choice_remove_gpu_version`, `speech_choice_copy_retires`. |

Why the pair is decided in the WebView: every input is already a command the
WebView calls, and the pair only steers what is shown and what a click
downloads. What must outlive the WebView (making the Intel GPU version the
after-meeting model, removing the Compressed copy) is native.

## The pair

- **Live**: the catalog's recommended Parakeet model (`recommended`), else
  `parakeet-tdt-0.6b-v3-int8`. It carries the "Intel NPU" badge when
  `ParakeetNpuStatus.present` and the model is Parakeet v3, the one #66
  prepares; the card drops it when the state is `failed`.
- **After meetings**: the catalog's recommended Whisper model, else
  `large-v3-turbo-q5_0` (the *regular copy*). When `get_openvino_availability`
  offers the download and `openvino_status` returns its companion without
  `refused`, the pair names the companion instead (the *Intel GPU version*,
  `large-v3-turbo-openvino-int8`), badged "Intel GPU".

Other computers get the same card without badges. Onboarding
(`SetupOverviewStep`) offers the same pair: Parakeet checked and locked (it is
needed to record), Whisper checked and uncheckable.

## The Intel GPU version is a model of its own

It is saved by its catalog id like any Whisper model (`whisper:<id>` after
meetings, `localWhisper:<id>` live). `discover_models` lists it after the
ggml models (`speech_choice::listed`, Windows only) with `companion_of` set,
named after the model it serves ("Large V3 Turbo"), Available once the
companion and its record are verified, else Missing. `WhisperAPI.getAvailableModels`
leaves it out of All models; the import and retranscribe pickers name it
"… · Intel GPU" (`gpuVersionLabel`).

`WhisperEngine::load_model` of its id (`load_gpu_version`):

1. the companion on OpenVINO, as #79 does for a ggml model. The load first
   clears the last backend outcome, and records "no Intel GPU it can run on"
   when the device rule picks none, so neither the message nor Settings
   reports an older load;
2. otherwise (not installed, Intel's libraries gone, pruned or refused, the
   crash guard, a failed compile, a GPU the device rule rejects) a regular
   copy from `companion_of` that is installed, the catalog's recommended one
   first, on whisper.cpp (`speech_choice::regular_copy`);
3. without one, an error: `speech_choice::no_copy_message` ("Whisper Large V3
   Turbo · Intel GPU didn't start, and no regular copy of the model is
   installed. Download the standard version in Settings › Transcription.").
   The technical reason goes to the log and Settings' tooltip only, and the
   passes' wrapper names the model the same way (`shown_name`).

Either way the engine names the Intel GPU version as its model, so the next
load of it is a no-op until an unload (`openvino_retry` and the end of a
download unload). Every place that loads the after-meeting model follows
this rule when the list says the Intel GPU version is missing
(`gpuVersionStandIn` in `lib/speech-choice.ts`, the same choice as
`regular_copy`): `resolveEnhancementModel` keeps the choice so native code
decides; the Import and Enhance dialogs preselect the copy it would run, or,
without one, keep it marked "(not installed)" so the pass reports what to
download instead of running another model; Settings › After the meeting
names it ("Whisper · Large V3 Turbo · Intel GPU is not on this computer, so
… is used instead", or that no copy is installed either). An explicitly
chosen `large-v3-turbo` or `large-v3-turbo-q5_0` keeps #79's behaviour: its
companion, when installed, runs in its place, and the selects badge it
"Intel GPU" then.

## Choosing it

The card, the offer and onboarding download it with
`openvino_download { id, choose: true }`. When the download ends installed,
`speech_choice::chosen` saves `whisper:<id>` as the after-meeting model in
native code, emits `post-call-transcript-config-changed`, and, when the
Compressed copy is installed at that moment, writes `.replaces-compressed`
into the companion's folder, naming that copy's file (size and modification
time). `openvino_download` holds `BusyReason::ModelDownload` until the choice
is saved, so an update cannot restart the app between the install and the
choice. An update of Intel's libraries from the card passes `choose: false`.

Removing it from the card (`speech_choice_remove_gpu_version`) refuses first
while the speech engines are busy (the rule `openvino_remove` applies), then
moves every choice of it to an installed regular copy (after meetings: else
"Same as during the meeting"; live: else Parakeet) and calls
`openvino_remove`. If that still refuses (a download or a transcription
started meanwhile), the choices it moved go back, except one the person
changed meanwhile.

## The update offer

Shown at the top of Settings › Transcription when at least one speech model is
installed (a first run gets the card's Download both instead), the offer is
not put off for every device it names, and this computer has an Intel GPU
without the Intel GPU version (`gpuOffered`, not installed, not downloading)
and/or an Intel NPU in `needs_runtime`. Titles: "Protocol can use your Intel
GPU and NPU", "… your Intel GPU", "… your Intel NPU". While Intel's libraries
download alone the NPU is not offered. Switch runs
`openvino_download { choose: true }` (it brings Intel's libraries, NPU files
included) or, for the NPU alone, `openvino_runtime_download`. When Switch is
cancelled or fails, the offer comes back, a failure with its reason in
device words (`intelError`). Not now stores
the devices it named in `localStorage` (`meetily-intel-offer-dismissed`): the
offer comes back only when it can name a device it did not name then (the NPU
after #66 arrives in an update). While it is put off and still applies, the
card ends with a link ("Use your Intel GPU…") that clears the key.

## The Compressed copy retires

`speech_choice::after_post_meeting_pass` runs after every successful
retranscription and import (both run `post_meeting::Pass`), once the pass's
own in-progress flag dropped; the pass's end asks `runs_on_gpu` before the
batch unload, and the hook gets the model the pass was asked for. On its own
task, under the optional Whisper operation lock and the engine lifecycle
lock, `retire_copy` gathers the facts and `retire` removes
`large-v3-turbo-q5_0` (`WhisperEngine::delete_model`, no choice reset) when
`retires_copy` holds:

- `.replaces-compressed` is in the companion's folder and names the installed
  copy's file as it is now (the person got the Intel GPU version through the
  card or the offer while this copy was installed);
- the copy is installed and the pass ran on OpenVINO;
- no recording runs and no other import or retranscription runs or waits;
- the pass was not asked for the copy (a pick in Import or Enhance
  transcript, which the companion then ran in its place);
- whisper.cpp does not hold the copy, also not behind the Intel GPU
  version's id after a fallback;
- neither the live choice nor the after-meeting choice is the copy (a live
  Whisper copy also covers "Same as during the meeting"), and the live
  choice is not an Intel GPU version that serves it: recording falls back to
  the copy when the Intel GPU does not start, and without it recording could
  not start at all.

The marker goes first, then the copy: if its removal fails, nothing is
deleted, and a crash in between leaves the copy without a marker, never a
marker without its copy. Then `optional-model-removed` (`whisper`) is
emitted. A marker that names another file, or a copy that is gone, outlived
its copy (removed in All models, downloaded again, a crash): it is removed at
the next pass or the next time Settings asks `speech_choice_copy_retires`, and
never removes anything. So a copy downloaded after the switch, for example
the standard version the card offers after a failure, stays.
Until then the card says "The Compressed copy stays until this one has
transcribed a meeting." (during the download, and afterwards while
`speech_choice_copy_retires` is true).

## States in the card

| State | Parakeet row | Whisper row |
| --- | --- | --- |
| Nothing installed (N1, N7) | — | — ; the header's "Download both · size" downloads both (on an NPU-only PC also Intel's libraries); one missing model gets its own "Download · size" |
| Downloading (N3) | progress with Cancel | progress in the download's own bytes (`CompanionStatus.progress`) with Cancel; "The Compressed copy stays…" when the copy is installed |
| NPU `waiting` / `preparing` | a note; "Preparing · about 2 min" with an indeterminate bar | |
| NPU `needs_runtime` | "Runs on the Intel NPU once Intel's libraries are downloaded.", their download with its bytes and Cancel, a failure under it (also with an Intel GPU version installed before the NPU files existed); with the Intel GPU version still to download the note says that download brings them | |
| Installed (N4) | Installed, Remove | Installed, Remove; an update of Intel's libraries; "used after a restart" |
| NPU `failed` (N6) | "The Intel NPU didn't start, so Parakeet runs on the processor." Try again (`parakeet_npu_retry`; `reason` in a tooltip) | |
| Intel GPU version fell back (N6) | | with a copy: the copy's row and "The Intel GPU version didn't start, so Whisper uses this copy. Nothing to download." Try again (`openvino_retry`); without: "… and no regular copy is installed …", Try again and "Download the standard version · size" (`whisper_download_model`, `enablePostCall: false`, so the choice stays) |

"Fell back" is `CompanionStatus.stopped` (the crash guard), the last load's
`fallbackReason` in this run (`get_local_stack_status`), or
`availability.mismatch`. Try again (`openvino_retry`) also clears the recorded
fallback natively, so the notice hides and comes back when a load falls back
again (the passes' events refresh the card). Download and removal errors
read in device words (`intelError` in `lib/intel-gpu.ts`), the native text in
a tooltip.

## Selects (N5)

During and After the meeting badge the device each installed model runs on
(`deviceOf`): the Intel GPU version, and a ggml model it runs in place of,
"Intel GPU" while it has not fallen back, except the full Large V3 Turbo it
is named after, which would otherwise read the same; Parakeet v3 "Intel NPU" once the
NPU is `ready` or `active`. whisper.cpp on Vulkan or the processor gets no
badge. The live list groups "On this computer" and "Not downloaded"; Parakeet
carries "recommended for live text" ("Light on power · …" on the NPU), and the
last entry opens All models without saving anything.

## Labs

The "Parakeet on the GPU" switch (Settings › Labs) and its "GPU · Labs" badge
are hidden while the NPU state is `preparing` or `ready`: the NPU wins (#66).

## Tests

- `tests/lib/speech-choice.test.ts`: the pair on an Intel GPU and NPU, each
  alone and neither, a refused companion, the catalog's recommendations; badges
  and fallbacks; the offer's conditions, titles and sizes, Not now per device;
  the Labs rule; the card's copy; what stands in for a missing Intel GPU
  version; native errors in device words.
- `tests/model-catalog/for-this-computer.test.tsx`: N1, N7, an NPU-only PC,
  Intel's libraries alone (bytes, Cancel, a kept failure, a download already
  running, onboarding's row), an Intel GPU version installed before the NPU
  files, N3, N4, the copy note only while it waits to retire, N6 with Try
  again and its notice coming back, no copy and the standard version, single
  downloads and failures in device words, the library update, the way back to
  the offer, and no technical words in the UI.
- `tests/model-catalog/speech-choice-settings.test.tsx`: the offer in
  Settings (Switch for GPU and NPU or NPU alone, Not now and the way back, none
  on a first run or once everything is used, a build without #66, the offer
  back after a failed or cancelled Switch), All models from the live select,
  the Labs badge, a chosen Intel GPU version that is gone (with and without a
  copy).
- `tests/model-catalog/transcription-models.test.tsx`: the Import and Enhance
  dialogs' preselection for a missing Intel GPU version, and its name.
- `tests/labs-npu.test.tsx`, `tests/onboarding-pair.test.tsx`: the Labs switch;
  setup's pair, its checkboxes, what Continue downloads, and Let's Go waiting
  for the pair.
- `speech_choice::tests` (Rust): `retires_copy` with every condition; `retire`
  driven on a temporary folder with a stand-in copy file and the settings
  database (migrations, in memory): the copy retires once, a copy downloaded
  later stays, a marker never removes a copy other than its own (removed and
  downloaded again, removed before a pass, Settings' check), a marker that
  cannot be removed keeps the copy, and the copy stays while a recording,
  another pass, an explicit pick, the engine or a live choice could load it;
  `load_model` of the Intel GPU version with no files and no copy; the
  fallback copy, the no-copy message, the id lookup, the choice move on
  removal and its restore.

## Limits

- Until #66 is merged its commands do not exist: the NPU reads as `absent`
  and `openvino_runtime_download` fails. The NPU states are tested with mocks.
- The fallback reason lives in memory: after a restart the card shows a
  fallen-back Intel GPU version only once a load fails again in that run (the
  crash guard's `stopped` survives restarts).
- A marker names its copy by size and modification time: a copy restored
  from a backup with its old time counts as the same copy.
- Who keeps Intel's libraries is #66's rule: on a PC with an Intel NPU and
  Parakeet v3 they stay when the Intel GPU version is removed, and
  `openvino_status.removesRuntime` says so; the card's Remove size follows it.
- A download of Intel's libraries started before the window reloaded is
  followed by its progress events; if it then fails, only its original caller
  got the error, so the card shows it running until the window reloads again.
- The Radix select menus render in a portal, which the component tests cannot
  open: the badges and hints in the menus are covered by the `deviceOf` tests
  and the real-app check.
