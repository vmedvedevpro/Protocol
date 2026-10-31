# NPU benchmark scripts (#66)

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
| `frontend/src-tauri/src/measure/npu.rs` | Two ignored Rust tests: `ort_plugin_smoke` (does the OpenVINO plugin EP load into the app's ONNX Runtime through `ort`, and does a Parakeet encoder session run on the NPU) and `paced_live` (the live-like scenario on the product's own engines). |

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
