"""The Whisper side of the simulated meeting (#80 round 2): OpenVINO GenAI's WhisperPipeline transcribes the
fixture's live pieces at the pace the live worker gets them, while the Rust probe (`measure::npu::paced_meeting`
with `PACED_ENGINE=labels`) runs live Nemotron on the same audio and reads each turn's label, on one clock.

    python whisper_meeting.py --model DIR --device GPU|NPU --cache DIR --pieces KIT_live.json --audio WAV
                              --seconds 900 --exe TEST_EXE --nemotron ONNX --out MEETING.json

Why two processes: the product's Whisper on OpenVINO (#79) is not on this branch, and live Nemotron is the
product's Rust code, so each runs where it exists; both devices go through the same two processes.

Order: the pipeline loads and decodes one piece untimed (the warm-up); then the probe starts with
`PACED_START_AT` a fixed lead in the future (it loads Nemotron meanwhile and fails if the lead was too short), and
both processes start the meeting's clock at that instant. The turns are the pieces looped over `--seconds`,
exactly as the probe's `turns` builds them: a turn is due when its piece ends; one call at a time, and a turn due
while the previous call runs waits and counts as late. The call is the product's live call: greedy, no
timestamps, the language fixed (`--language`, openvino#37937).

The probe gets no `BENCH_MARKS`, so the cell sees one `meeting` mark, written here with the calls' summary, the
probe's (labelled turns, diarization failures) and the probe's process id, which `cells.py` counts as the cell's
own CPU.
"""

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np

import whisper_ov
from marks import phase

RATE = 16000
# The probe loads Nemotron (DirectML, 400 MB) in 3-5 s after it starts; the lead leaves room for a slow start.
LEAD_S = 25.0


def turns(pieces: Path, audio_len: int, seconds: float) -> list[tuple[int, int, float]]:
    """`measure::npu::turns`: the kit's pieces looped over `seconds`, each due when it ends."""
    kit = json.loads(pieces.read_text(encoding="utf-8"))
    spans = [(int(p["start_ms"] * 16), int(p["end_ms"] * 16)) for p in kit["pieces"] if p["skipped"] is None]
    total = int(seconds * 1000 * 16)
    out = []
    for offset in range(0, total, audio_len):
        for start, end in spans:
            if offset + end <= total:
                out.append((offset + start, offset + end, (offset + end) / RATE))
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--pieces", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--language", default="ru")
    parser.add_argument("--seconds", type=float, default=900.0)
    parser.add_argument("--exe", required=True, help="the kit's test binary with measure::npu::paced_meeting")
    parser.add_argument("--nemotron", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    audio = whisper_ov.read_wav(args.audio)
    schedule = turns(args.pieces, len(audio), args.seconds)
    looped = np.tile(audio, int(args.seconds * RATE) // len(audio) + 1)[:int(args.seconds * RATE)]

    with phase("load", device=args.device):
        started = time.perf_counter()
        pipe = whisper_ov.build(args.model, args.device, args.cache, False, False)
        load_s = time.perf_counter() - started
    config = whisper_ov.generation_config(pipe, args.language, "none", 1)
    with phase("warmup"):
        pipe.generate(looped[:6 * RATE], config)
    print(f"{args.device}: load {load_s:.1f} s, {len(schedule)} turns over {args.seconds} s", flush=True)

    start_at = time.time() + LEAD_S
    probe_out = args.out.with_name(args.out.stem + "-probe.json")
    env = {k: v for k, v in os.environ.items() if k != "BENCH_MARKS"}
    env.update(MEASURE_AUDIO=str(args.audio), PACED_PIECES=str(args.pieces), PACED_ENGINE="labels",
               PACED_SECONDS=str(args.seconds), PACED_START_AT=f"{start_at:.3f}", PACED_OUT=str(probe_out),
               MEASURE_DIARIZATION_MODEL=args.nemotron, RUST_LOG=env.get("RUST_LOG", "warn"))
    probe = subprocess.Popen([args.exe, "measure::npu::paced_meeting", "--ignored", "--exact", "--nocapture"],
                             env=env)

    time.sleep(max(start_at - time.time(), 0.0))
    # The meeting's clock on perf_counter, anchored to the shared wall-clock instant.
    clock0 = time.perf_counter() - (time.time() - start_at)
    calls, late = [], 0
    for start, end, due_s in schedule:
        wait = clock0 + due_s - time.perf_counter()
        if wait > 0:
            time.sleep(wait)
        else:
            late += 1
        began = time.perf_counter() - clock0
        text = pipe.generate(looped[start:end], config).texts[0]
        done = time.perf_counter() - clock0
        calls.append({"due_s": due_s, "start_s": round(began, 3), "transcribe_ms": round((done - began) * 1000, 1),
                      "lag_s": round(done - due_s, 3), "audio_s": (end - start) / RATE, "text": text.strip()})
    wait = clock0 + args.seconds - time.perf_counter()
    if wait > 0:
        time.sleep(wait)
    t1 = start_at + (time.perf_counter() - clock0)
    try:
        code = probe.wait(timeout=120)
    except subprocess.TimeoutExpired:
        probe.kill()
        code = None
    probe_summary = json.loads(probe_out.read_text(encoding="utf-8"))["summary"] if probe_out.exists() else {}

    latencies = sorted(c["transcribe_ms"] for c in calls)
    pick = lambda q: latencies[round((len(latencies) - 1) * q)]
    summary = {"device": args.device, "acceleration": f"OpenVINO GenAI {args.device}", "audio_s": args.seconds,
               "calls": len(calls), "late_calls": late, "max_lag_s": max(c["lag_s"] for c in calls),
               "latency_ms_median": pick(0.5), "latency_ms_p95": pick(0.95), "latency_ms_max": pick(1.0),
               "busy_share": round(sum(latencies) / 1000 / args.seconds, 4), "load_s": round(load_s, 2),
               "probe_exit": code, "labelled": probe_summary.get("labelled"),
               "label_turns": probe_summary.get("calls"), "label_late": probe_summary.get("late_calls"),
               "diarization_failures": probe_summary.get("diarization_failures"), "child_pids": [probe.pid]}
    path = os.environ.get("BENCH_MARKS")
    if path:
        with open(path, "a", encoding="utf-8") as file:
            file.write(json.dumps({"phase": "meeting", "t0": start_at, "t1": t1, **summary}) + "\n")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"summary": summary, "calls": calls}, indent=1, ensure_ascii=False),
                        encoding="utf-8")
    print(f"meeting: {json.dumps(summary)}", flush=True)
    if code != 0:
        raise SystemExit(f"the probe exited with {code}")


if __name__ == "__main__":
    main()
