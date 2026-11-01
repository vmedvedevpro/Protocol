"""Writes the cell specs of #80's night for `cells.py`, with the paths of the measured laptop.

    python make_cells.py floor --seed 1 --out CELL.json                       (resident floor, ABBA around idle)
    python make_cells.py meeting --exe TEST_EXE --device npu --out CELL.json   (idle, the simulated meeting, idle)
    python make_cells.py busy --exe TEST_EXE --devices dml,npu --out CELL.json (the meeting, the GPU decoding video)
    python make_cells.py batch --seed 1 --out CELL.json                        (fleurs-ru, interleaved warm repeats)

The floor cell: no-model idle blocks between every two resident blocks, the three devices in a random order and
then in the reverse order (ABC CBA), so that a linear drift over the cell cancels in each device's mean and every
resident block has an idle block on both sides.
"""

import argparse
import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NB = Path("C:/Users/User/npu-bench")
ORT = str(NB / "venv-ort/Scripts/python.exe")
PK = str(NB / "models/parakeet-tdt-0.6b-v3-int8")
NPU_CACHE = str(NB / "80/cache/pk-npu-608")
AUDIO = str(ROOT / ".measure/fixtures/fleurs-ru/audio.wav")
PIECES = str(ROOT / ".measure/runs/66/kit-parakeet-cpu/rep1/parakeet.json")
SCRIPT = str(ROOT / "scripts/npu-bench/parakeet_ort.py")
NEMOTRON = str(NB / "80/models/nemotron3_diar_v3.onnx")  # a copy of the app's pinned model
PLUGIN = str(NB / "dl/nuget-ov-ep-1.8.1/extracted/runtimes/win-x64/native/onnxruntime_providers_openvino_plugin.dll")
# The NuGet plugin shares the PyPI plugin's compile cache (one OpenVINO build); parakeet_ort.py writes this file.
NPU_OPTIONS = ("OpenVINOExecutionProvider.reshape_input=audio_signal[1,128,608],length[1];"
               "OpenVINOExecutionProvider.load_config=" + str(NB / "80/cache/pk-npu-608.load_config.json"))
# A 1080p30 H.264 clip, decoded in real time on the Arc's video engine and scaled to 720p by its video processor:
# the steady GPU work of a video call's incoming stream. `-re` paces the decode at the clip's frame rate.
CLIP = str(NB / "80/clip-1080p30.mp4")
FFMPEG = str(ROOT / "frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe")
# A video call's GPU side at real-time pace: decode the 1080p30 H.264 clip, scale it to 720p and encode that
# at 2 Mbit/s, all in Quick Sync (the bundled ffmpeg's scale_d3d11 fails to negotiate a null output). The clip
# (120 s) repeats through a concat list of 40 entries (80 min): -stream_loop makes vpp_qsv reinitialize at the
# loop point, which fails (-40) and ends the load, with or without -reinit_filter 0.
CLIP_LIST = str(NB / "80/clip-loop.txt")
VIDEO_LOAD = [FFMPEG, "-hide_banner", "-loglevel", "error", "-hwaccel", "qsv", "-hwaccel_output_format", "qsv",
              "-c:v", "h264_qsv", "-re", "-f", "concat", "-safe", "0", "-i", CLIP_LIST, "-vf", "vpp_qsv=w=1280:h=720",
              "-c:v", "h264_qsv", "-b:v", "2M", "-f", "null", "-"]
# The encoder of each device as `parakeet_ort.py` builds it. 608 frames is the NPU's static shape (6.07 s, the
# VAD's 6 s cap plus the preprocessor's frame); DirectML gets it too, since one shape is what makes it fast.
ENCODERS = {"npu": ["--encoder", "ov-npu", "--frames", "608", "--cache", NPU_CACHE],
            "dml": ["--encoder", "dml", "--frames", "608"],
            "cpu": ["--encoder", "cpu"]}
# The fixed-shape variant item 6 chose (best or near best on fleurs-ru and fleurs-en): overlapping 608-frame
# windows over each stretch, 3.5 s apart, started in a pause, a window TDT skips run again 0.5 s later.
CHUNKED = ["--chunking", "overlap", "--hop-s", "3.5", "--snap-s", "0.5", "--retry-words-per-s", "0.5"]
ENCODERS["npu-overlap"] = ENCODERS["npu"] + CHUNKED


def idle(seconds: float, settle: float, phase: str = "idle") -> dict:
    return {"name": phase, "kind": "idle", "phase": phase, "seconds": seconds, "settle": settle}


def resident(device: str, seconds: float, settle: float) -> dict:
    return {"name": device, "kind": "cmd",
            "cmd": [ORT, SCRIPT, "--model", PK, *ENCODERS[device], "--audio", AUDIO, "--out", "none",
                    "--resident", str(seconds), "--resident-settle", str(settle)]}


def floor(seed: int, seconds: float, settle: float) -> dict:
    order = ["npu", "dml", "cpu"]
    random.Random(seed).shuffle(order)
    steps = [idle(seconds, settle)]
    for device in order + order[::-1]:
        steps += [resident(device, seconds, settle), idle(seconds, settle)]
    return {"kind": "floor", "seed": seed, "order": order + order[::-1], "steps": steps}


def meeting_step(exe: str, device: str, seconds: float, out: str, frames: int | None = None) -> dict:
    env = {"MEASURE_AUDIO": AUDIO, "MEASURE_PARAKEET_MODEL": PK, "PACED_PIECES": PIECES, "PACED_DEVICE": device,
           "PACED_SECONDS": str(seconds), "PACED_OUT": out, "MEASURE_DIARIZATION_MODEL": NEMOTRON,
           "RUST_LOG": "warn"}
    if device == "npu":
        env.update(NPU_EP_PLUGIN=PLUGIN, NPU_EP_OPTIONS=NPU_OPTIONS, NPU_FRAMES="608")
    elif frames:
        env["PACED_STATIC_FRAMES"] = str(frames)
    name = device + (f"-{frames}" if frames and device != "npu" else "")
    return {"name": name, "kind": "cmd",
            "cmd": [exe, "measure::npu::paced_meeting", "--ignored", "--exact", "--nocapture"], "env": env}


def meeting(exe: str, device: str, seconds: float, idle_s: float, out: Path, frames: int | None) -> dict:
    name = device + (f"-{frames}" if frames else "")
    return {"kind": "meeting", "device": name, "steps": [
        idle(idle_s, 20), meeting_step(exe, device, seconds, str(out / f"meeting-{name}.json"), frames),
        idle(idle_s, 30)]}


def busy(exe: str, devices: list[str], seconds: float, idle_s: float, out: Path) -> dict:
    """Idle, the video load alone, then each device's meeting under the load with the load alone between them,
    then idle again: the load's own power is the load-alone blocks minus the idle ones."""
    Path(CLIP_LIST).write_text("".join(f"file '{Path(CLIP).as_posix()}'\n" for _ in range(40)), encoding="utf-8")
    steps = [idle(idle_s, 20), {"kind": "load-start"}, idle(idle_s, 20, "load-alone")]
    for device in devices:
        base, _, frames = device.partition("-")
        steps += [meeting_step(exe, base, seconds, str(out / f"meeting-{device}.json"), int(frames) if frames else None),
                  idle(idle_s, 30, "load-alone")]
    steps += [{"kind": "load-stop"}, idle(idle_s, 30)]
    return {"kind": "busy", "devices": devices, "load": VIDEO_LOAD, "steps": steps}


def batch_run(device: str, name: str, out: Path, cache: str | None = None) -> dict:
    encoder = list(ENCODERS[device])
    if cache is not None:
        encoder[encoder.index("--cache") + 1] = cache
    return {"name": name, "kind": "cmd",
            "cmd": [ORT, SCRIPT, "--model", PK, *encoder, "--audio", AUDIO, "--pieces", PIECES, "--reps", "1",
                    "--out", str(out / name / "parakeet.json")]}


def batch(seed: int, reps: int, cold_idle_s: float, out: Path, devices: list[str]) -> dict:
    """A cold start after a long idle (the NPU, warm cache), then `reps` warm runs per device in a random order,
    each a new process (a warm load from the caches) with idle gaps, then one cold compile into an empty cache."""
    runs = [d for d in devices for _ in range(reps)]
    random.Random(seed).shuffle(runs)
    steps = [idle(cold_idle_s, 0), batch_run("npu", "cold-npu", out)]
    count: dict[str, int] = {}
    for device in runs:
        count[device] = count.get(device, 0) + 1
        steps += [idle(40, 15), batch_run(device, f"{device}-{count[device]}", out)]
    steps += [idle(40, 15), batch_run("npu", "compile-npu", out, str(NB / f"80/cache/pk-npu-608-cold-{seed}")),
              idle(40, 15)]
    return {"kind": "batch", "seed": seed, "order": runs, "steps": steps}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("floor", "meeting", "busy", "batch"))
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--seconds", type=float, help="floor: 180 per block; meeting: 1800; busy: 900 per device")
    parser.add_argument("--settle", type=float, default=20.0)
    parser.add_argument("--idle", type=float, default=240.0, help="meeting/busy: the idle blocks around it")
    parser.add_argument("--exe", help="the kit's test binary with measure::npu::paced_meeting")
    parser.add_argument("--device", choices=("cpu", "dml", "npu"))
    parser.add_argument("--frames", type=int, help="meeting: pad to this static shape (DirectML 608)")
    parser.add_argument("--devices", help="busy: cpu, dml, dml-608, npu (dml,npu); batch: npu, dml, cpu, "
                        "npu-overlap (npu,dml,cpu)")
    parser.add_argument("--reps", type=int, default=5)
    parser.add_argument("--cold-idle", type=float, default=600.0)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    cell_dir = args.out.resolve().parent
    if args.kind == "floor":
        spec = floor(args.seed, args.seconds or 180.0, args.settle)
    elif args.kind == "meeting":
        spec = meeting(args.exe, args.device, args.seconds or 1800.0, args.idle, cell_dir, args.frames)
    elif args.kind == "busy":
        spec = busy(args.exe, (args.devices or "dml,npu").split(","), args.seconds or 900.0, args.idle, cell_dir)
    else:
        spec = batch(args.seed, args.reps, args.cold_idle, cell_dir, (args.devices or "npu,dml,cpu").split(","))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(spec, indent=1), encoding="utf-8")
    print(f"{args.out}: {[s.get('name', s['kind']) for s in spec['steps']]}")


if __name__ == "__main__":
    main()
