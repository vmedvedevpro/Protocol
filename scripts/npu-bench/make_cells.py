"""Writes the cell specs of #80's night for `cells.py`, with the paths of the measured laptop.

    python make_cells.py floor --seed 1 --out CELL.json                       (resident floor, ABBA around idle)
    python make_cells.py meeting --exe TEST_EXE --device npu --out CELL.json   (idle, the simulated meeting, idle)
    python make_cells.py busy --exe TEST_EXE --devices dml,npu --out CELL.json (the meeting, the GPU decoding video)
    python make_cells.py batch --seed 1 --out CELL.json                        (fleurs-ru, interleaved warm repeats)

The floor cell: no-model idle blocks between every two resident blocks, the three devices in a random order and
then in the reverse order (ABC CBA), so that a linear drift over the cell cancels in each device's mean and every
resident block has an idle block on both sides.

Round 2 (GPU against NPU for Whisper and Parakeet, each comparison inside one cell, a no-model idle block around
every workload block):

    python make_cells.py r2-meeting --model wh --exe TEST_EXE --out CELL.json   (9 min blocks, GPU NPU NPU GPU)
    python make_cells.py r2-paced --model pk --out CELL.json              (6 s every 6 s, 5 min, GPU NPU NPU GPU)
    python make_cells.py r2-floor --out CELL.json                         (Whisper resident, GPU NPU NPU GPU)
    python make_cells.py r2-batch --model wh --seed 1 --out CELL.json     (4 fresh processes per device and feed)
    python make_cells.py r2-starts --seed 1 --out CELL.json               (first start into empty caches)

Whisper is OpenVINO GenAI's WhisperPipeline on one IR for both devices; Parakeet's encoder runs on DirectML
(`gpu`) or the NPU through the OpenVINO plugin EP, always with 608-frame static shapes, the preprocessor and
decoder on the CPU. Step names are `<model>-<device>` (`wh-gpu`, `pk-npu`), batch runs
`<model>-<feed>-<device>-<n>` (`wh-live-gpu-3`, `pk-b-npu-1`); `summarise.py r2-*` pairs them by that name.
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

# Round 2. Whisper: the IR the product will ship (#79's pin: OpenVINO/whisper-large-v3-turbo-int8-ov at
# b568445d, the 11 files GenAI reads), copied out of #79's folder; the same files on the GPU and the NPU.
OV = str(NB / "venv-ov/Scripts/python.exe")
WH = str(NB / "80/models/whisper-large-v3-turbo-int8-ov")
WH_SCRIPT = str(ROOT / "scripts/npu-bench/whisper_ov.py")
WH_MEETING = str(ROOT / "scripts/npu-bench/whisper_meeting.py")
WH_LIVE = str(ROOT / ".measure/runs/66/vulkan-q5_0/rep1/live.json")  # 46 pieces <= 6 s, the same as PIECES
WH_POST = str(ROOT / ".measure/runs/66/vulkan-q5_0/rep1/post-meeting.json")  # 15 pause-to-pause pieces
WH_HEARD = str(ROOT / ".measure/runs/80/r2-heard/heard.json")  # measure::npu::whisper_heard on WH_POST
OV_DEVICE = {"gpu": "GPU", "npu": "NPU"}
# Warm compile caches, filled by the smoke run before the cells; the starts cell compiles into empty ones.
WH_CACHE = {d: str(NB / f"80/cache/wh-{d}") for d in OV_DEVICE}
# Parakeet: feed A is each VAD piece zero-padded to 608 frames, feed B the overlapping 608-frame windows of
# round 1 (CHUNKED); DirectML gets the static shape too, so both devices run the same graph on the same input.
PK_ENCODER = {"gpu": ["--encoder", "dml", "--frames", "608"],
              "npu": ["--encoder", "ov-npu", "--frames", "608", "--cache", NPU_CACHE]}
PK_FEED = {"a": [], "b": CHUNKED}
# Passes per batch repeat: about 40 s of work or more on the faster device at the smoke's speeds (the owner's
# shorter schedule), the same count on both devices, so both transcribe the same audio.
BATCH_PASSES = {("wh", "live"): 6, ("wh", "post"): 8, ("pk", "a"): 8, ("pk", "b"): 5}


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
    # A device may carry its own count, `npu-overlap:3`.
    runs = [d.split(":")[0] for d in devices for _ in range(int(d.split(":")[1]) if ":" in d else reps)]
    random.Random(seed).shuffle(runs)
    steps = [idle(cold_idle_s, 0), batch_run("npu", "cold-npu", out)]
    count: dict[str, int] = {}
    for device in runs:
        count[device] = count.get(device, 0) + 1
        steps += [idle(40, 15), batch_run(device, f"{device}-{count[device]}", out)]
    steps += [idle(40, 15), batch_run("npu", "compile-npu", out, str(NB / f"80/cache/pk-npu-608-cold-{seed}")),
              idle(40, 15)]
    return {"kind": "batch", "seed": seed, "order": runs, "steps": steps}


def wh_cmd(device: str, *args: str, cache: str | None = None) -> list[str]:
    return [OV, WH_SCRIPT, "--model", WH, "--device", OV_DEVICE[device], "--cache", cache or WH_CACHE[device],
            "--audio", AUDIO, "--language", "ru", *args]


def pk_cmd(device: str, feed: str, *args: str, cache: str | None = None) -> list[str]:
    encoder = list(PK_ENCODER[device])
    if cache is not None and "--cache" in encoder:
        encoder[encoder.index("--cache") + 1] = cache
    return [ORT, SCRIPT, "--model", PK, *encoder, *PK_FEED[feed], "--audio", AUDIO, *args]


def r2_meeting(model: str, order: list[str], exe: str, seconds: float, idle_s: float, out: Path) -> dict:
    """The meeting on each device twice in ABBA order (GPU NPU NPU GPU), each block a fresh process between
    no-model idle blocks; the cell compares the devices pass by pass."""
    steps = [idle(idle_s, 20)]
    for n, device in enumerate(order + order[::-1]):
        name = f"{model}-{device}"
        result = str(out / f"meeting-{name}-{n + 1}.json")
        if model == "pk":
            step = meeting_step(exe, "dml" if device == "gpu" else "npu", seconds, result,
                                608 if device == "gpu" else None)
            step["name"] = name
        else:
            step = {"name": name, "kind": "cmd", "env": {"MEASURE_AUDIO": AUDIO},
                    "cmd": [OV, WH_MEETING, "--model", WH, "--device", OV_DEVICE[device], "--cache", WH_CACHE[device],
                            "--pieces", WH_LIVE, "--audio", AUDIO, "--language", "ru", "--seconds", str(seconds),
                            "--exe", exe, "--nemotron", NEMOTRON, "--out", result]}
        steps += [step, idle(idle_s, 20)]
    return {"kind": "r2-meeting", "model": model, "order": order + order[::-1], "steps": steps}


def r2_paced(model: str, order: list[str], seconds: float, idle_s: float, out: Path) -> dict:
    """One 6 s window every 6 s for `seconds`, each device twice in ABBA order, a fresh process per block and a
    no-model idle block between any two."""
    steps = [idle(idle_s, 20)]
    for device in order + order[::-1]:
        n = sum(1 for s in steps if s.get("name", "").startswith(f"{model}-{device}")) + 1
        name = f"{model}-{device}"
        result = str(out / f"{name}-{n}" / "paced.json")
        cmd = (wh_cmd(device, "--pieces", "none", "--out", result, "--paced", str(seconds)) if model == "wh"
               else pk_cmd(device, "a", "--out", result, "--paced", str(seconds)))
        steps += [{"name": name, "kind": "cmd", "cmd": cmd}, idle(idle_s, 20)]
    return {"kind": "r2-paced", "model": model, "order": order + order[::-1], "steps": steps}


def r2_floor(order: list[str], seconds: float, settle: float) -> dict:
    """Whisper loaded and warm, no calls, each device twice in ABBA order between no-model idle blocks."""
    steps = [idle(seconds, settle)]
    for device in order + order[::-1]:
        cmd = wh_cmd(device, "--pieces", "none", "--out", "none", "--resident", str(seconds),
                     "--resident-settle", str(settle))
        steps += [{"name": f"wh-{device}", "kind": "cmd", "cmd": cmd}, idle(seconds, settle)]
    return {"kind": "r2-floor", "order": order + order[::-1], "steps": steps}


def r2_batch(model: str, seed: int, reps: int, out: Path, feeds: list[str] | None = None,
             passes: int | None = None) -> dict:
    """`reps` runs per device and feed, each a fresh process (a warm load from the caches) whose timed repeat is
    BATCH_PASSES passes over the feed, with a no-model idle block before every run. The order is randomised in
    complete blocks: every block holds each device and feed once, shuffled, so the devices interleave and a drift
    over the cell falls on all of them alike."""
    feeds = feeds or (["live", "post"] if model == "wh" else ["a", "b"])
    configs = [(feed, device) for feed in feeds for device in ("gpu", "npu")]
    rng = random.Random(seed)
    runs = [run for _ in range(reps) for run in rng.sample(configs, len(configs))]
    steps: list[dict] = []
    count: dict[tuple[str, str], int] = {}
    for feed, device in runs:
        count[(feed, device)] = count.get((feed, device), 0) + 1
        name = f"{model}-{feed}-{device}-{count[(feed, device)]}"
        count_passes = str(passes or BATCH_PASSES[(model, feed)])
        if model == "wh":
            kind = "live" if feed == "live" else "post-meeting"
            args = ["--pieces", WH_LIVE if feed == "live" else WH_POST, "--reps", "1", "--passes", count_passes,
                    "--out", str(out / name / f"{kind}.json")]
            if feed == "post":
                args += ["--timestamps", "segment", "--heard", WH_HEARD]
            cmd = wh_cmd(device, *args)
        else:
            cmd = pk_cmd(device, feed, "--pieces", PIECES, "--reps", "1", "--passes", count_passes,
                         "--out", str(out / name / "parakeet.json"))
        steps += [idle(120 if not steps else 40, 15), {"name": name, "kind": "cmd", "cmd": cmd}]
    steps.append(idle(40, 15))
    return {"kind": "r2-batch", "model": model, "seed": seed, "order": [f"{f}-{d}" for f, d in runs], "steps": steps}


def r2_starts(seed: int, warm: bool = False) -> dict:
    """First start of each model and device into an empty compile cache (a fresh folder per cell), between idle
    blocks: the load and the first call. Warm loads come from the batch cells' runs. `warm` (the smoke) points
    at the warm caches instead."""
    cold = NB / f"80/cache/r2-cold-{seed}"
    steps = [idle(120, 0)]
    for device in ("gpu", "npu"):
        steps += [{"name": f"wh-{device}-cold", "kind": "cmd",
                   "cmd": wh_cmd(device, "--pieces", WH_LIVE, "--out", "none", "--load-only",
                                 cache=None if warm else str(cold / f"wh-{device}"))}, idle(60, 15)]
    for device in ("gpu", "npu"):
        steps += [{"name": f"pk-{device}-cold", "kind": "cmd",
                   "cmd": pk_cmd(device, "a", "--pieces", PIECES, "--out", "none", "--load-only",
                                 cache=None if warm else str(cold / f"pk-{device}"))}, idle(60, 15)]
    return {"kind": "r2-starts", "seed": seed, "cache_root": str(cold), "steps": steps}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("floor", "meeting", "busy", "batch", "r2-meeting", "r2-paced", "r2-floor",
                                         "r2-batch", "r2-starts"))
    parser.add_argument("--model", choices=("wh", "pk"), help="round 2: Whisper or Parakeet")
    parser.add_argument("--order", default="gpu,npu", help="round 2: the devices' order (gpu,npu or npu,gpu)")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--seconds", type=float, help="floor: 180 per block; meeting: 1800; busy: 900 per device")
    parser.add_argument("--settle", type=float, default=20.0)
    parser.add_argument("--idle", type=float, help="meeting/busy: the idle blocks around it (240; round 2: 180, "
                        "paced 120)")
    parser.add_argument("--exe", help="the kit's test binary with measure::npu::paced_meeting")
    parser.add_argument("--device", choices=("cpu", "dml", "npu"))
    parser.add_argument("--frames", type=int, help="meeting: pad to this static shape (DirectML 608)")
    parser.add_argument("--devices", help="busy: cpu, dml, dml-608, npu (dml,npu); batch: npu, dml, cpu, "
                        "npu-overlap (npu,dml,cpu)")
    parser.add_argument("--reps", type=int, help="batch: 5; r2-batch: 4")
    parser.add_argument("--feeds", help="r2-batch: live,post (wh) or a,b (pk)")
    parser.add_argument("--passes", type=int, help="r2-batch: passes per repeat instead of BATCH_PASSES (smoke)")
    parser.add_argument("--warm", action="store_true", help="r2-starts: the warm caches (smoke)")
    parser.add_argument("--cold-idle", type=float, default=600.0)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    cell_dir = args.out.resolve().parent
    if args.kind == "floor":
        spec = floor(args.seed, args.seconds or 180.0, args.settle)
    elif args.kind == "meeting":
        spec = meeting(args.exe, args.device, args.seconds or 1800.0, args.idle or 240.0, cell_dir, args.frames)
    elif args.kind == "busy":
        spec = busy(args.exe, (args.devices or "dml,npu").split(","), args.seconds or 900.0, args.idle or 240.0,
                    cell_dir)
    elif args.kind == "batch":
        spec = batch(args.seed, args.reps or 5, args.cold_idle, cell_dir, (args.devices or "npu,dml,cpu").split(","))
    elif args.kind == "r2-meeting":
        spec = r2_meeting(args.model, args.order.split(","), args.exe, args.seconds or 540.0, args.idle or 120.0,
                          cell_dir)
    elif args.kind == "r2-paced":
        spec = r2_paced(args.model, args.order.split(","), args.seconds or 300.0, args.idle or 120.0, cell_dir)
    elif args.kind == "r2-floor":
        spec = r2_floor(args.order.split(","), args.seconds or 180.0, args.settle)
    elif args.kind == "r2-batch":
        spec = r2_batch(args.model, args.seed, args.reps or 4, cell_dir,
                        args.feeds and args.feeds.split(","), args.passes)
    else:
        spec = r2_starts(args.seed, args.warm)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(spec, indent=1), encoding="utf-8")
    print(f"{args.out}: {[s.get('name', s['kind']) for s in spec['steps']]}")


if __name__ == "__main__":
    main()
