# NPU benchmark scripts (#66, #80)

Throwaway tooling that measured Whisper and Parakeet on the Intel NPU against the Arc iGPU and the CPU of a
Core Ultra X7 358H laptop. It is not product code: it reuses the measurement kit
([docs/MEASURING_TRANSCRIPTION.md](../../docs/MEASURING_TRANSCRIPTION.md)) for the product path and its scoring,
and runs the NPU candidates from Python on the kit's own pieces, so every configuration transcribes the same
samples and `measure.py score` compares them side by side.

| File | What it does |
| --- | --- |
| `pdh.py` | Windows performance counters through PDH, without admin: RAPL energy (`Energy Meter`, cumulative pWh) and `GPU Engine` utilization, where the NPU appears as a compute-only adapter. |
| `sampler.py` | Samples energy at 10 Hz and CPU/GPU/NPU utilization at 1 Hz into JSON lines. |
| `bench.py` | Runs a command under the sampler after a 60 s idle baseline and writes `power.json`: per phase, energy, average power, package power above idle, J above idle per audio minute, and engine utilization (the proof of where the work ran). |
| `marks.py` | Phase marks (load, warm-up, each repeat, the paced run) a workload writes for `bench.py`. |
| `kit_runs.py` | Runs the Rust kit's `transcribe_settings` N times, each a new process into its own folder. |
| `whisper_ov.py` | OpenVINO GenAI `WhisperPipeline` on NPU/GPU/CPU on the kit's pieces, written as a kit run. |
| `whisper_checks.py` | The NPU pipeline's state checks (openvino#37937): a language switch between calls, audio longer than 30 s, drift over repeated calls. |
| `parakeet_ort.py` | Parakeet TDT 0.6B v3 INT8 on ONNX Runtime 1.24.4 (DirectML build) with the encoder on the CPU, DirectML or the OpenVINO plugin EP (NPU/GPU/CPU), the preprocessor and decoder on the CPU as in the app; static-shape padding for the NPU. |
| `paced.py` | The live-like scenario: one 6 s window every 6 s at real-time pace. |
| `frontend/src-tauri/src/measure/npu.rs` | Ignored Rust tests: `ort_plugin_smoke` (does the OpenVINO plugin EP load into the app's ONNX Runtime through `ort`, and does a Parakeet encoder session run on the NPU), `paced_live` (the live-like scenario on the product's own engines) and `paced_meeting` (#80: a meeting at real-time pace, the kit's VAD pieces into the product's `ParakeetEngine` with its encoder on the CPU, DirectML or the NPU, while live Nemotron diarizes the same audio and labels each turn). |
| `state.py` | (#80) The machine state each block records: AC or battery, power scheme and overlay, display timeout and whether the display is off, seconds since the last input. |
| `cells.py` | (#80) Runs a cell, a spec of steps (idle blocks with no model loaded, workload commands, a background load started and stopped) under one sampler, and analyses it: per marked block, the power of each RAPL rail, the 10 s median, engine utilization, and what else ran (other processes' CPU and GPU, C-states, interrupts, temperature), with blocks flagged when that background moved. |
| `make_cells.py` | (#80) Writes the cell specs of the #80 scenarios: the resident floor (idle and each device resident in a random A/B/C C/B/A order), the paced meeting per device, the meeting on a busy GPU (a hardware video pipeline in ffmpeg) and the batch repeats with cold starts. |
| `summarise.py` | (#80) Pools cells into the report's numbers: each block against the mean of its neighbouring idle blocks, with a t-based 95 % interval. |
| `chunking.py` | (#80) Static-shape windows over a stretch of speech (right context from the next piece, or overlapping windows started in a pause) and the merge of their words; `parakeet_ort.py --chunking` uses it. |

## Setup

Python 3.12 venvs outside the repository (paths as on the measured laptop):

```powershell
py -3.12 -m venv C:\Users\User\npu-bench\venv-ov
C:\Users\User\npu-bench\venv-ov\Scripts\python -m pip install openvino==2026.4.1 openvino-genai==2026.4.1.0 openvino-tokenizers==2026.4.1.0
py -3.12 -m venv C:\Users\User\npu-bench\venv-export
C:\Users\User\npu-bench\venv-export\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
C:\Users\User\npu-bench\venv-export\Scripts\python -m pip install "optimum-intel[openvino]" openvino==2026.4.1 openvino-tokenizers==2026.4.1.0 nncf
py -3.12 -m venv C:\Users\User\npu-bench\venv-ort
C:\Users\User\npu-bench\venv-ort\Scripts\python -m pip install onnxruntime-directml==1.24.4 onnxruntime-ep-openvino==1.8.1 numpy
```

Whisper large-v3-turbo for OpenVINO:

```powershell
C:\Users\User\npu-bench\venv-export\Scripts\optimum-cli export openvino --model openai/whisper-large-v3-turbo --weight-format int8 C:\Users\User\npu-bench\models\whisper-large-v3-turbo-int8
C:\Users\User\npu-bench\venv-export\Scripts\optimum-cli export openvino --model openai/whisper-large-v3-turbo --weight-format fp16 C:\Users\User\npu-bench\models\whisper-large-v3-turbo-fp16
```

The kit's Vulkan build (a short target dir; the commands below run its test binary directly):

```powershell
$env:CARGO_TARGET_DIR = 'C:\t66'
cargo test --release -p protocol --no-default-features --features vulkan --lib --no-run
```

## Commands

Every run goes through `bench.py`, one at a time, with nothing else heavy running. The product path, from the
repository root (Git Bash; `$W` the repository root, `$M` the app's models folder):

```sh
python scripts/npu-bench/bench.py --out .measure/runs/66/vulkan-q5_0 -- python scripts/npu-bench/kit_runs.py \
  --exe C:/t66/release/deps/app_lib-<hash>.exe --out $W/.measure/runs/66/vulkan-q5_0 --reps 3 \
  MEASURE_AUDIO=$W/.measure/fixtures/fleurs-ru/audio.wav MEASURE_LANGUAGE=ru MEASURE_SETTINGS=post-meeting,live \
  MEASURE_WHISPER_MODEL=$M/ggml-large-v3-turbo-q5_0.bin
```

An NPU candidate on the same pieces:

```sh
python scripts/npu-bench/bench.py --out .measure/runs/66/ov-npu-int8-live -- \
  C:/Users/User/npu-bench/venv-ov/Scripts/python scripts/npu-bench/whisper_ov.py \
  --model C:/Users/User/npu-bench/models/whisper-large-v3-turbo-int8 --device NPU \
  --pieces .measure/runs/66/vulkan-q5_0/rep1/live.json --audio .measure/fixtures/fleurs-ru/audio.wav \
  --out .measure/runs/66/ov-npu-int8-live/live.json --cache C:/Users/User/npu-bench/cache/ov-npu-int8
```

Score any set of runs of one setting against the human reference:

```sh
.measure/venv/Scripts/python scripts/measure/measure.py score .measure/runs/66/vulkan-q5_0/rep1/live.json \
  .measure/runs/66/ov-npu-int8-live/live.json --reference .measure/fixtures/fleurs-ru/reference.json
```

The exact command of every measured configuration is in the results report of #66.

## #80: cells

A cell is one `cells.py` run under the measurement lock; every block in it is compared with the idle blocks
next to it, so drift over the cell cancels. Build the probe first (`paced_meeting`, release, the Vulkan build
of the kit; Parakeet and Nemotron run on ONNX Runtime either way):

```powershell
$env:CARGO_TARGET_DIR = 'C:\t80'
cargo test --release -p protocol --no-default-features --features vulkan --lib --no-run
```

Then, from the repository root (`$ORT` the `venv-ort` Python, `$EXE` the test binary the build printed):

```sh
$ORT scripts/npu-bench/make_cells.py floor --seed 5 --out .measure/runs/80/floor-2/cell-spec.json
$ORT scripts/npu-bench/make_cells.py meeting --exe $EXE --device npu --out .measure/runs/80/meeting-npu/cell-spec.json
$ORT scripts/npu-bench/make_cells.py busy --exe $EXE --devices dml,npu --out .measure/runs/80/busy/cell-spec.json
$ORT scripts/npu-bench/make_cells.py batch --seed 3 --out .measure/runs/80/batch/cell-spec.json
$ORT scripts/npu-bench/cells.py --out .measure/runs/80/floor-2 --spec .measure/runs/80/floor-2/cell-spec.json
$ORT scripts/npu-bench/summarise.py floor .measure/runs/80/floor-*
```

The model, cache, plugin and video clip paths are constants at the top of `make_cells.py`. Fixed-shape
accuracy needs no cell (CPU only, no timing):

```sh
$ORT scripts/npu-bench/parakeet_ort.py --model $PK --encoder cpu --audio .measure/fixtures/fleurs-ru/audio.wav \
  --pieces .measure/runs/66/kit-parakeet-cpu/rep1/parakeet.json --reps 1 --frames 608 \
  --chunking overlap --hop-s 4 --snap-s 0.5 --out .measure/runs/80/accuracy/cpu-608-overlap4-snap/parakeet.json
```
