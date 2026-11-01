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
   `openvino-ir` entry, see below). The user downloads it in Settings; nothing
   is downloaded on their behalf.
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
4. The runtime loads and the model compiles on that device.

If 1–3 do not hold, whisper.cpp loads as before and nothing is reported. If 4
fails, the error is logged (`OpenVINO could not take over Whisper; falling back
to whisper.cpp on Vulkan: …`), Settings › Local stack shows it under Whisper,
and whisper.cpp loads. A failure inside a transcription call is returned to the
caller like a whisper.cpp error; the call is not repeated on whisper.cpp.

Settings › Local stack shows `OpenVINO GPU` (the device name) in the Whisper
row while the model runs on OpenVINO (`get_local_stack_status`,
`whisper.openvino`). `get_openvino_availability` tells the model settings
whether to offer the companion download here.

## Runtime

`build/openvino.rs` is the one table of where the runtime comes from: the
archive URL, its size and SHA-256, and the size and SHA-256 of every file
staged into `binaries/openvino/` (the same staging code as ONNX Runtime,
`build/onnxruntime.rs::ensure_runtime`). Windows x64 only; other targets stage
nothing.

- Source today: Intel's GenAI 2026.4.1 Windows archive. 11 libraries
  (`openvino_genai_c`, `openvino_genai`, `openvino_c`, `openvino`, the GPU and
  CPU plugins, the IR frontend, `openvino_tokenizers`, oneTBB's three), 110 MB
  on disk, plus the licence files. The CPU plugin is needed even on the GPU:
  GenAI compiles the tokenizer and detokenizer models on the CPU. The NPU
  plugin (108 MB) and the other frontends are left out.
- Licence: the archive's binaries are under the Intel OpenVINO Distribution
  License (staged as `openvino-EULA.txt`; redistribution of the files in
  `redist.txt` allowed), not Apache-2.0. **Open: the owner decides** between
  shipping them and building `openvino_genai_c.dll` from the Apache-2.0
  sources against the Apache-2.0 PyPI wheels (#79 report). Switching the source
  is a change of this table only.
- No network: none of the 11 libraries imports WinHTTP, WinINet, Winsock or
  urlmon. The data collection the EULA allows (clause 7.2) is the Python
  `openvino_telemetry` package of the converter tools, which Protocol does not
  ship or load.
- Loading (`whisper_engine/openvino/genai.rs`): on first use, by absolute path
  from the app's resources, with `LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR |
  LOAD_LIBRARY_SEARCH_DEFAULT_DIRS`, so dependencies resolve from that folder
  and System32 only. It stays loaded for the process, like ONNX Runtime; a
  failed load is kept and reported, and whisper.cpp runs.

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
  is `<data>/cache/openvino`: the first load of the model compiles GPU
  kernels (seconds), later loads read them back.
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
  laptop and another vendor (`device.rs`), the piece trim and the model
  folder check (`openvino/mod.rs`), the runtime stage against its pins
  (`onnx_runtime_build_tests::openvino`).
- The measurement kit opens an OpenVINO model folder given as
  `MEASURE_WHISPER_MODEL`; its results against `main` are in #79's PR.
- `verify-windows-release.mjs` checks that the installer carries exactly the
  staged runtime files.

## Open

- The runtime's licence and source (above).
- Beam search (above).
- Language pinning on Auto (above).
- The OpenVINO cache is not pruned when the model or the runtime changes.
- A companion installed while the ggml model is loaded on whisper.cpp takes
  effect at the next model load (idle unload or restart).
