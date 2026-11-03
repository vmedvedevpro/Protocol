# Whisper on OpenVINO (Intel GPUs)

Issue #79. On Windows, the Vulkan build can run Whisper Large V3 Turbo on an
Intel GPU through OpenVINO GenAI's `WhisperPipeline` instead of whisper.cpp.
On an Arc B390 (Core Ultra X7 358H) the measurement kit on `fleurs-ru`, three
interleaved pairs against `main` under the #66 energy harness, gave:

| | post-meeting × real time | J per audio minute | WER | live × real time | J per audio minute | WER |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| whisper.cpp 1.8.3, Vulkan, q5_0 (`main`) | 9.1 | 111 | 6.4 % | 7.3 | 198 | 10.8 % |
| OpenVINO GenAI 2026.4.1, GPU, int8 | 36.6 | 29 | 6.0 % | 30.3 | 50 | 10.1 % |

(medians; energy is the package's above idle; post-meeting is beam 5 on
whisper.cpp and greedy on OpenVINO). This note says when it runs, who owns
what, and what is still open.

## When it runs

All of these, checked when a Whisper model loads (`WhisperEngine::load_model`):

1. The app is the Windows Vulkan build (`WhisperCompiledBackend::Vulkan`). The
   CPU build and other platforms never load OpenVINO.
2. The model has an OpenVINO companion and it is installed and verified
   (`model_catalog::openvino::installed_companion`; the catalog's
   `openvino-ir` entry, see below), and so is Intel's runtime
   (`model_catalog::openvino::runtime_to_load`, below). The user downloads
   both with one click in Settings; nothing is downloaded on their behalf.
3. The device rule (`whisper_engine/openvino/device.rs`) ties the GPU
   whisper.cpp would use (`acceleration::whisper_gpu_device`, the first
   discrete GPU, else the first GPU; `acceleration::whisper_gpu` reports it)
   to an OpenVINO GPU whose `DEVICE_ARCHITECTURE` names vendor `0x8086`:
   - by PCI address when ggml-vulkan reports one
     (`ggml_backend_dev_props::device_id`, `0000:00:02.0`, against OpenVINO's
     `DEVICE_PCI_INFO`); the address then decides alone;
   - otherwise by name and type: the one OpenVINO GPU whose
     `FULL_DEVICE_NAME`, without the ` (iGPU)` / ` (dGPU)` suffix the plugin
     appends, is the Vulkan device name ggml reports, and whose
     `DEVICE_TYPE` (integrated or discrete) agrees. Two GPUs of that name and
     type match nothing.

   Why both: ggml-vulkan fills `device_id` only from `VK_EXT_pci_bus_info`,
   and the Arc B390's Windows driver (the one machine this was built and
   measured on) does not offer it, so an address-only rule never fired there.
   The log says which way the device matched, or lists OpenVINO's GPUs when
   none did. Either way a hybrid laptop keeps its NVIDIA or AMD GPU on
   whisper.cpp (neither its address nor its name is an Intel GPU's), and an
   Intel iGPU plus an Arc card runs on the card.
4. The runtime loads and the model compiles on that device, and the app did
   not close unexpectedly inside OpenVINO before (the crash guard, under
   Loading).

If 1 or 3 does not hold, or no companion is installed, whisper.cpp loads as
before and nothing is reported. A companion whose runtime is missing (its
folder removed) or one this build cannot run counts as a failure of 4. If 4
fails, the error is logged (`OpenVINO could not take over Whisper; falling back
to whisper.cpp on Vulkan: …`), Settings › Local stack shows it under Whisper,
and whisper.cpp loads. A failure inside a transcription call is returned to the
caller like a whisper.cpp error; the call is not repeated on whisper.cpp.

Settings › Local stack shows `OpenVINO GPU` (the device name) in the Whisper
row while the model runs on OpenVINO (`get_local_stack_status`,
`whisper.openvino`). `get_openvino_availability` tells the model settings
whether to offer the download here, and once the runtime is installed which
device the rule picks or why it picks none (the row shows the mismatch). The
row names that device by the GPU's name, as its description does (the rule
picks the GPU whisper.cpp uses), not by OpenVINO's `GPU` or `GPU.<n>`.

### Offering the download before the runtime is there

Without the runtime, OpenVINO cannot be asked about devices. So the offer
(`device::offer_for`) uses what the app knows without it: the Vulkan build,
the GPU whisper.cpp picks (`acceleration::whisper_gpu`: its Vulkan name), and
the vendor of the display adapters Windows lists under that name (the display
class in the registry: `DriverDesc`, and the `VEN_` of `MatchingDeviceId`).
Only vendor 0x8086 is offered; a name Windows does not list, or lists for
another or an unknown vendor, is not. Windows keeps entries of adapters no
longer present (the test machine lists a B370 beside its B390); they matter
only if they share the GPU's name. Once the runtime is installed, rule 3
decides as before, and a GPU OpenVINO does not list is shown under the row
(`availability.mismatch`) instead of silently staying on whisper.cpp.

## Runtime

Protocol ships none of Intel's binaries. The catalog's `runtimes` list
([MODEL_CATALOG.md](MODEL_CATALOG.md#runtimes)) pins the runtime the way
models are pinned: Intel's own archive by URL, size and SHA-256, and each file
the app takes from it by its path in the archive, size and SHA-256. Each PC
downloads it from Intel's server, under Intel's licence, as it fetches models
from Hugging Face, and a new version reaches installs through the catalog,
without a Protocol release.

- Source today: Intel's GenAI 2026.4.1 Windows archive
  (`storage.openvinotoolkit.org`, 254 MB; Settings counts binary megabytes
  and shows 242 MB). 12 libraries (`openvino_genai_c`, `openvino_genai`,
  `openvino_c`, `openvino`, the GPU, CPU and auto-batching plugins, the IR
  frontend, `openvino_tokenizers`, oneTBB's three), 110 MB (105 in Settings)
  on disk, plus Intel's licence files (`openvino-EULA.txt` and the third-party
  notices), which stay beside the libraries. The CPU plugin is
  needed even on the GPU: GenAI compiles the tokenizer and detokenizer models
  on the CPU. The auto-batching plugin (0.2 MB) is there because every
  compile asks for it (below, under Loading). The NPU, AUTO and HETERO
  plugins (the NPU one is 108 MB) and the other frontends stay in the
  archive.
- Licence: the binaries are under the Intel OpenVINO Distribution License
  (the archive's `docs/licensing/EULA.txt`; Settings links Intel's copy). The
  person's PC downloads them from Intel; Protocol does not redistribute them.
- Where it comes from is this build's, not the catalog's: the catalog is not
  signed and the runtime is native code every install loads, so a catalog
  commit can choose a version but not a server or a publisher. The archive
  must be on `storage.openvinotoolkit.org` (`schema::runtime_host`, https, no
  port or user; both catalog checks hide another host), a redirect is
  followed only to https on that host, and each `.dll` must carry a valid
  Authenticode signature of Intel Corporation (`model_catalog/authenticode.rs`,
  `WinVerifyTrust` with no revocation check whatever the machine's policy,
  `WTD_REVOKE_NONE` and `WTD_REVOCATION_CHECK_NONE`; all 12 of 2026.4.1 are
  signed by Intel) before it is marked verified. These rules ship with each app and
  cannot be loosened for it afterwards.
- No network: none of the 12 libraries imports WinHTTP, WinINet, Winsock or
  urlmon. The data collection the EULA allows (clause 7.2) is the Python
  `openvino_telemetry` package of the converter tools, which is not among the
  pinned files.

### Install (`model_catalog/runtime.rs`)

One click on Download in Settings (`openvino_download`) installs what the
companion lacks: the catalog's runtime version, then the companion. The
runtime install:

1. checks the volume has room for the archive and the files;
2. downloads the archive from the pinned host (above) into
   `<data>/runtimes/openvino-genai/.staging-<version>/` and hashes it as it
   streams in (`model_integrity::Check`); a mismatch deletes it;
3. extracts only the pinned files, each under its catalog name (an archive
   path is looked up, never used as a path; a name must be one that Windows
   keeps apart from the others and from the install's own files, see
   [MODEL_CATALOG.md](MODEL_CATALOG.md#runtimes)), each checked against its
   own pin and each library against Intel's signature, then given a
   `.verified` marker;
4. deletes the archive, writes `runtime.json` (id, version, API level, the
   files' pins) and renames the staging folder to `<version>`. Windows
   refuses to rename a folder while a file in it is open, and an antivirus
   scans fresh libraries, so the rename and the archive's deletion wait out
   a lock for up to 20 s before they fail.

A failure or Cancel removes the staging folder, so a version folder is always
complete; a staging folder a crash left is removed at the next start. The
download reports one progress over the parts it fetches, as bytes done of
their total (`CompanionStatus::progress`): the row prints those, not its own
size, which changes once the runtime is in during a full download and counts
both parts during an update that fetches only the runtime. It holds
`BusyReason::ModelDownload` for its lifetime. Installs, removals and prunes of
the runtime and the companions run one at a time (`openvino::OPERATIONS`): they
share the runtime's folder and the question whether a companion still needs
it, and a prune holds the engine's runtime slot, so no version starts loading
from a folder being deleted. When the companion's part fails or is cancelled
after the runtime installed, a `.requested` file in the companion's folder
keeps the runtime (the next click fetches only the companion; the row also
offers to remove the libraries) until the companion is installed or removed. A version is installed when its
record is there and every file has a valid marker (`runtime::verified`:
metadata reads, no hashing); a file changed since loses its marker and the
version counts as missing.

### Loading and compatibility

`whisper_engine::openvino::runtime` loads the runtime on first use
(`runtime_to_load`), an installed version of the binding's API level: the one
the catalog names, else the newest one older than it (an update not
downloaded yet), never a newer one. So a catalog that steps back retires a
version it pinned before: a newer version is not loaded but shown as "the
model list no longer offers …", the row offers the catalog's version, and the
next prune deletes the newer one. Without any offer (no catalog entry this
build can run), the newest installed one. It loads by absolute path from that
folder with `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS`,
so dependencies resolve from that folder and System32 only, and stays loaded
for the process. A process loads at most one version, once: the libraries of
two versions share their names, and Windows resolves a dependency by name to
the one already loaded. A runtime that is not installed is looked for again
on the next load.

`genai::API_LEVEL` (1) names the GenAI C API the binding calls: the functions
it binds with the signatures of GenAI 2026.4.1's headers. Each catalog entry
states its runtime's level (`api`); the app installs and loads only entries
and installed versions of its own level, since a C signature can change under
the same symbol name. A new binding level comes with an app release, and the
catalog then pins one runtime per level in use, so older apps keep theirs. An
installed version of another level is refused with a message ("… is
installed, but this version of Protocol cannot run it …"), and a runtime whose
libraries do not load or lack a symbol is refused by the load; either is
logged and shown in Local stack, and whisper.cpp runs. When neither the
catalog in use nor the built-in one has a runtime this build can run, the
Settings row says so instead of offering a download.

GenAI 2026.4.1 builds a `std::filesystem::path` from the `const char*` paths
of its C API (`whisper_pipeline.cpp`, `whisper_generation_config.cpp`), which
MSVC reads not as UTF-8 but in the code page `__std_fs_code_page` picks: UTF-8
under a UTF-8 CRT locale, else the ANSI code page (the OEM one if file APIs
were switched to it). OpenVINO's own string options (`CACHE_DIR`) are UTF-8
(`ov::util::make_path`). An ASCII path reads the same in every code page, so
the model folder goes to GenAI as it is when it is ASCII, else by its 8.3
short name when that is ASCII (a Cyrillic user name, on any code page), and
only then in that code page (a Latin-1 name under code page 1252);
`CACHE_DIR` goes as UTF-8 (`genai::genai_path`). A path with none of these
forms (no short names on the volume, and characters the code page lacks) is
refused with a message, and whisper.cpp runs.

GenAI loads its tokenizer extension (`openvino_tokenizers.dll`) from the path
in `OPENVINO_TOKENIZERS_PATH_GENAI`, which it reads through the C runtime and
keeps when it is already set (`ScopedVar`, `tokenizer_impl.cpp`), loading that
file unchecked. Before the libraries load, the binding sets it to the
runtime folder's verified copy through the same Universal CRT
(`ucrtbase.dll`'s `_wputenv_s`; a variable set through Win32 after the CRT
started would not be seen), so a value inherited from the environment cannot
bring in another copy.

The device rule asks only OpenVINO's GPU plugin for its devices
(`AVAILABLE_DEVICES`, then each `GPU.<n>`'s properties; `genai::GenAi::gpus`):
listing every device would load every plugin OpenVINO registered. OpenVINO
registers a plugin it was built with only where it finds the file:
`openvino-2026.4.1\` under the runtime's folder, the folder itself, or the
process's current directory (`get_compiled_plugin_path`; nothing is looked up
on PATH). The pipelines are created on a `GPU` name, which loads the GPU
plugin and, for GenAI's tokenizer, the CPU plugin. Every compile of a model
GenAI builds in memory (the decoder, tokenizer and detokenizer) also asks for
the auto-batching plugin (`apply_auto_batching`, whatever the hints), so the
runtime carries it, and the catalog must list it (`schema::RUNTIMES`): found
in the folder, it is never looked for in the current directory. Batching
itself stays off: GenAI's Whisper sets no `THROUGHPUT` hint, and the GPU
plugin's default is `LATENCY`.

Crash guard: loading the libraries, asking the GPU plugin and compiling a
model run native code that a broken driver or runtime can crash in, beyond
any `Result`. While any of these steps runs, the app keeps
`<data>/runtimes/openvino-genai.attempt` naming the steps running, one per
line, and removes it when none runs. A marker found by the first such step of
a process was left by one that died there: OpenVINO then stays off
(whisper.cpp runs) and the Settings row says "Protocol closed unexpectedly the
last time OpenVINO was …" with "Try OpenVINO again" (`openvino_retry`), which
removes the marker and lets the next model load try. Meanwhile the row drops
its "Used on the Intel GPU" tag, and a download that ends then says Whisper
stays on Vulkan. Without it, a crash in
OpenVINO would repeat at every start. A process that ends on purpose while a
step runs (Quit, `RunEvent::Exit`, or the updater closing the app to install)
removes the marker first and writes none afterwards (`set_closing`), so
quitting during a compile is not taken for a crash; an update that fails to
install turns the guard back on.

### Update and removal

When the catalog pins another version for this build's level, the row offers
it ("OpenVINO GenAI X is available · N MB to download", Update), as a model
update is offered; the click is the same download. The new version installs
beside the old one. If this process has not loaded the old one, it is removed
at once and the next model load uses the new one; if it has, the row and the
toast that ends the download (it reads the status again) say the new version
is used after a restart, and the old one is removed at the next start
(`prune_at_startup`, called after the catalog is set and before anything
loads the runtime). A version the catalog moves back to (a rollback)
is installed and used the same way.

Remove in the row removes the companion, and with the last companion the
runtime (a version this process loaded goes at the next start) and the model
cache. At startup, a runtime no companion needs (none installed or begun) is
removed too. A version left on disk only because this process loaded it
counts as gone in the row until then (`RuntimeStatus::removed_at_restart`):
the row offers the download as the next start leaves it and says that
Intel's libraries are removed when Protocol restarts, rather than showing
them installed with a "Remove the libraries" that cannot delete them. A
download before that restart keeps the version and fetches only the
companion.

## Model

The companion of `large-v3-turbo` and `large-v3-turbo-q5_0` is
`OpenVINO/whisper-large-v3-turbo-int8-ov` (MIT) pinned to commit `b568445d`,
11 files, 828 MB: int8 weights (asymmetric, per channel), the
`optimum-intel` export GenAI reads. It is a separate download because
GenAI cannot read ggml files. `whisper_engine::openvino::MODEL_FILES` lists the
files the engine requires.

## Engine and lifecycle

`whisper_engine/openvino/mod.rs`:

- `OpenVinoWhisper` owns one pipeline: the encoder and the stateful decoder
  compiled for one device. `WhisperEngine` keeps it in `openvino`, in place of
  a whisper.cpp context. Unload, a model switch and the idle unloader drop the
  engine's `Arc`; a call in flight keeps its own `Arc`, so the pipeline is
  freed when that call returns.
- Compiling holds `BusyReason::ModelCompile` in the busy registry, so an
  update cannot restart the app in the middle of it. OpenVINO's `CACHE_DIR`
  is `<data>/cache/openvino/<runtime version>_<model commit, 12>`: the first
  load of a model on a runtime compiles GPU kernels (seconds, 0.8 GB), later
  loads read them back. A blob compiled by one runtime is not for another, and
  a model update brings new weights, so both start a new folder; each compile
  removes the folders of other runtime versions and of commits no installed
  companion has (`prune_cache`), and removing the last companion removes the
  cache.
- Calls run on Tokio's blocking pool, one at a time per pipeline (a mutex):
  GenAI keeps one infer request per model and the decoder state between the
  steps of a generation.
- After a failed `generate` the pipeline is dropped and compiled again (from
  the cache) before the next call: GenAI 2026.4.1 skips resetting the decoder
  state and the sampler when a generation throws.

## Decoding

- Live: greedy, no timestamps, as whisper.cpp's live call; the text goes
  through the same `clean_repetitive_text`.
- Post-meeting (retranscription, import, the kit): greedy with segment
  timestamps; the segments become rows as whisper.cpp's do. The product's
  whisper.cpp pass uses beam 5. GenAI 2026.4.1 crashes with beams on the GPU
  (the encoder output is a GPU remote tensor that the beam path reads as host
  memory; fixed on GenAI master in September–October 2026). **Removal
  criterion:** with GenAI 2026.5.0 or later, measure beam 5 with the kit and
  switch if it beats greedy.
- The repeat and its fix (`speech_end`): the batch VAD ends a piece after 2 s
  without speech and keeps that pause. Given the pause after the last
  sentence, greedy decoding in GenAI 2026.4.1 can open another segment and copy
  the sentence into it, inside one encoder pass (beam on the nightly does too;
  without timestamps it does not). So the OpenVINO call hears the piece only to
  its last speech plus the VAD's own 250 ms pad. A piece cut inside speech at a
  25 s mark keeps its end: the trim applies only when Silero, at the most
  sensitive thresholds the pass uses, finds no speech in the last 2 s.
  whisper.cpp is unchanged; its beam search and temperature fallback do not
  produce the copy on the measured pieces.
- Language on Auto: GenAI's C API does not return the language it detected
  (`WhisperDecodedResults::language` exists only in C++), so the pass cannot
  detect once per track and pin it; each call detects on its own window.
  `detect_language_with_probability` reports this, and the pass falls back to
  per-piece detection, as it does after a failed detection. Building the C API
  ourselves (licence option b) would allow a 20-line `get_language`.

## Tests and measurements

- Unit tests: the device rule's two paths, two identical cards, a hybrid
  laptop and another vendor, and the offer by the display adapters' vendor
  (`device.rs`); the piece trim, the model folder check, the cache keying
  and pruning, and the crash guard (a marker naming every step running, a
  panic, a marker left by a dead process stopping OpenVINO until a retry, a
  quit during a step not taken for a crash) (`openvino/mod.rs`); a folder
  whose libraries are no GenAI C API is refused without a crash, GPU names as
  OpenVINO forms them, a path handed to GenAI naming the same folder when read
  back as MSVC reads it (ASCII as it is, a Cyrillic and a Latin-1 folder by
  the ASCII short name, and through the code page where it holds them), and
  loading a runtime replacing an inherited tokenizer path with its own
  (`genai.rs`).
- The catalog: the `runtimes` rules in the shared cases
  (`entry-cases.json`: `runtime_cases`, among them another host, a host that
  only ends like the pinned one, a port, a user, file names that clash
  without case, a trailing dot, device names, the install's own names, and a
  runtime without the auto-batching plugin), a
  broken runtime list that hides only runtimes, one entry per runtime,
  platform and level (`schema.rs`, `check-catalog.test.mjs`); a companion's
  `runtime`.
- The install (`model_catalog/runtime.rs`, against a local server and a zip
  made in the test): only the pinned files extracted and verified and the
  archive deleted; a corrupt archive, a wrong file hash and a file missing
  from the archive install nothing; a cancel mid-download leaves nothing and
  an installed older version alone; a new version beside the old one, then
  pruned; a leftover staging folder; an unverified version folder replaced;
  an archive off the pinned host refused before any request; a redirect off
  it failing the download; an unsigned library installing nothing; a rename
  and a deletion waiting out a file held open. `authenticode.rs`: an unsigned
  file refused.
- The one action (`model_catalog/openvino.rs`): the runtime then the companion
  with one progress, the busy registry held, a second click fetching nothing,
  an update and a companion-only download each counting only what they fetch,
  the percentage never 100 before the end,
  a cancel during the runtime leaving neither, a runtime kept when the
  companion's part fails; which version loads (the catalog's, an older one
  while an update waits, never a newer one the catalog withdrew, never
  another level); what the row says before, during and after an install, for
  an update and after an update while the old version runs, and when no
  runtime can be installed; a removal that frees the runtime only when no
  other companion keeps it; a runtime awaiting its removal at the next start
  counted as gone, until a download of the companion keeps it.
- Settings: `tests/model-catalog/openvino-acceleration.test.tsx` (the row's
  text, sizes and licence link, the offer, progress in the download's own
  bytes (also during an update and after the runtime part) and cancel, the device
  and the mismatch, a removed runtime, an update and its restart note and toast, a
  failure and a refusal, the crash note and its retry, libraries without the
  model, offered for removal only when that removes them, and libraries a
  restart removes shown as such with the full download).
- Ignored, with an installed runtime (`OPENVINO_TEST_RUNTIME`): Intel's 12
  libraries pass the signature check (`authenticode.rs`), and GenAI itself
  reads a file in a Cyrillic and in a Latin-1 folder through `genai_path`,
  the Latin-1 one also through the code page alone, while the UTF-8 bytes
  miss both (`genai.rs`, with `OPENVINO_TEST_MODEL`).
- The measurement kit opens an OpenVINO model folder given as
  `MEASURE_WHISPER_MODEL`, with the runtime installed by the app (or a folder
  in `MEASURE_OPENVINO_RUNTIME`, installed by the ignored
  `installs_the_catalogs_runtime_from_intel`); its results against `main` are
  in #79's PR.

## Open

- Beam search (above).
- Language pinning on Auto (above).
- A companion installed while the ggml model is loaded on whisper.cpp takes
  effect at the next model load (idle unload or restart); a runtime version
  installed after another was loaded, at the next start.
- A runtime download does not resume: after a failure, Cancel or a restart it
  starts over (242 MB). The companion's download resumes.
- Trust: the catalog (from GitHub, unsigned) picks the version and its
  hashes; the host and the publisher are this build's. A malicious catalog
  can still make installs fetch another genuine Intel release from Intel's
  server, or withdraw the runtime, not load foreign code.
- A model folder whose path the system code page cannot hold, on a volume
  without 8.3 names, stays on whisper.cpp (with a message).
- OpenVINO still registers the NPU, AUTO and HETERO plugins from the current
  directory when it holds files of those names; the app never names those
  devices, so they are not loaded.
