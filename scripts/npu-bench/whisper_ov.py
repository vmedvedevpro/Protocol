"""Whisper through OpenVINO GenAI's WhisperPipeline on the kit's own pieces, written as a kit run.

    python whisper_ov.py --model DIR --device NPU --pieces KIT_RUN.json --audio WAV --out RUN.json
                         [--timestamps segment|word|none] [--beams 1] [--static] [--cache DIR] [--reps 3]
    python whisper_ov.py ... --paced 300 --period 6        (the live-like scenario instead of the pieces)

The pieces (their times, and which the kit skipped) come from a run of the Rust kit on the same audio
(`live.json` for the live call, `post-meeting.json` for the pass), so every configuration transcribes exactly
the samples the product path transcribed and `measure.py score` compares them side by side. The output is that
run with this engine's rows, times and decoding: one row per piece without timestamps (the live call), Whisper's
segments as rows with them (the pass).

Timing: the pipeline is built once (`load`: a cold compile with an empty cache, a warm one from it), the first
transcribed piece is decoded once untimed (`warmup`), then all pieces `--reps` times (`rep1`...). The written
times are the median repeat's; the texts are the last repeat's, and `repeats_identical` says whether every repeat
gave the same texts (openvino#37937: the NPU pipeline reuses state between calls). Each call's perf metrics
(time to first token, which holds the encoder, and time per output token, the decoder) are kept per piece.

Not reproduced: the product's text cleanup after the call (its repetition cleanup and the post-meeting pass's
silence-hallucination filter), so a hallucination the product would drop is scored here.
"""

import argparse
import copy
import json
import statistics
import time
import wave
from pathlib import Path

import numpy as np
import openvino_genai as ov_genai

import paced
from marks import phase

SAMPLES_PER_MS = 16


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav:
        assert wav.getframerate() == 16000 and wav.getnchannels() == 1 and wav.getsampwidth() == 2, path
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def dir_bytes(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0


def build(model: Path, device: str, cache: Path | None, static: bool, word_timestamps: bool):
    properties = {}
    if cache is not None:
        properties["CACHE_DIR"] = str(cache)
    if static:
        properties["STATIC_PIPELINE"] = True
    if word_timestamps:
        properties["word_timestamps"] = True
    return ov_genai.WhisperPipeline(str(model), device, **properties)


def generation_config(pipe, language: str | None, timestamps: str, beams: int):
    config = pipe.get_generation_config()
    config.task = "transcribe"
    config.language = f"<|{language}|>" if language else None
    config.return_timestamps = timestamps != "none"
    if timestamps == "word":
        config.word_timestamps = True
    config.num_beams = beams
    if beams > 1:
        config.num_return_sequences = 1
    return config


def metrics(result) -> dict:
    perf = result.perf_metrics
    return {"generate_ms": round(perf.get_generate_duration().mean, 1),
            "ttft_ms": round(perf.get_ttft().mean, 1),
            "tpot_ms": round(perf.get_tpot().mean, 2),
            "tokens": perf.get_num_generated_tokens(),
            "features_ms": round(perf.get_features_extraction_duration().mean, 1)}


def rows_of(result, piece: dict, timestamps: str) -> list[dict]:
    if timestamps == "none" or not result.chunks:
        text = result.texts[0].strip()
        return [{"start_ms": piece["start_ms"], "end_ms": piece["end_ms"], "text": text}] if text else []
    rows = []
    for chunk in result.chunks:
        text = chunk.text.strip()
        if not text:
            continue
        start = piece["start_ms"] + chunk.start_ts * 1000.0
        end = piece["start_ms"] + (chunk.end_ts if chunk.end_ts >= 0 else (piece["end_ms"] - piece["start_ms"]) / 1000.0) * 1000.0
        rows.append({"start_ms": round(start, 1), "end_ms": round(min(end, piece["end_ms"]), 1), "text": text})
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--pieces", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--language", default="ru")
    parser.add_argument("--timestamps", choices=("none", "segment", "word"), default="none")
    parser.add_argument("--beams", type=int, default=1)
    parser.add_argument("--static", action="store_true")
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--paced", type=float)
    parser.add_argument("--period", type=float, default=6.0)
    args = parser.parse_args()

    audio = read_wav(args.audio)
    if args.paced:
        run_paced(args, audio)
        return
    kit = json.loads(args.pieces.read_text(encoding="utf-8"))
    pieces = [p for p in kit["pieces"] if p["skipped"] is None]
    samples = [audio[int(p["start_ms"] * SAMPLES_PER_MS):int(p["end_ms"] * SAMPLES_PER_MS)] for p in pieces]
    speech_s = sum(len(s) for s in samples) / 16000.0
    print(f"{len(pieces)} pieces, {speech_s:.1f} s of speech; kit speech {kit['timing']['speech_ms'] / 1000:.1f} s")

    cache_before = dir_bytes(args.cache) if args.cache else 0
    with phase("load", cache_bytes_before=cache_before) as mark:
        started = time.perf_counter()
        pipe = build(args.model, args.device, args.cache, args.static, args.timestamps == "word")
        load_s = time.perf_counter() - started
    cache_after = dir_bytes(args.cache) if args.cache else 0
    print(f"load {load_s:.1f} s, cache {cache_before / 1e6:.0f} -> {cache_after / 1e6:.0f} MB")
    config = generation_config(pipe, args.language, args.timestamps, args.beams)

    with phase("warmup"):
        started = time.perf_counter()
        pipe.generate(samples[0], config)
        warmup_s = time.perf_counter() - started
    print(f"warm-up {warmup_s:.1f} s")

    reps = []
    for rep in range(1, args.reps + 1):
        walls, results = [], []
        with phase(f"rep{rep}", audio_s=speech_s):
            for piece_samples in samples:
                started = time.perf_counter()
                result = pipe.generate(piece_samples, config)
                walls.append((time.perf_counter() - started) * 1000.0)
                results.append(result)
        texts = [r.texts[0] for r in results]
        reps.append({"walls": walls, "results": results, "texts": texts, "total_ms": sum(walls)})
        print(f"rep{rep}: {sum(walls) / 1000:.2f} s, {speech_s / (sum(walls) / 1000):.2f}x real time")

    median = sorted(reps, key=lambda r: r["total_ms"])[len(reps) // 2]
    last = reps[-1]
    run = copy.deepcopy(kit)
    run["model"] = f"{args.model.name} (OpenVINO GenAI {ov_genai.__version__})"
    run["acceleration"] = f"OpenVINO {args.device}" + (" STATIC_PIPELINE" if args.static else "")
    decoding = "greedy" if args.beams == 1 else f"beam {args.beams}"
    by_time = iter(range(len(pieces)))
    for piece in run["pieces"]:
        if piece["skipped"] is not None:
            continue
        i = next(by_time)
        piece["wall_ms"] = round(median["walls"][i], 1)
        piece["decoding"] = decoding
        piece["rows"] = [dict(row, speakers=None) for row in rows_of(last["results"][i], piece, args.timestamps)]
        piece["ov_metrics"] = metrics(last["results"][i])
        piece["dropped"] = False
    run["timing"] = dict(kit["timing"], transcription_ms=round(median["total_ms"], 1), warmup_ms=round(warmup_s * 1000, 1),
                         detection_ms=0.0, speech_ms=round(speech_s * 1000, 1))
    run["ov"] = {"device": args.device, "static_pipeline": args.static, "timestamps": args.timestamps,
                 "beams": args.beams, "load_s": round(load_s, 2), "cache_dir": str(args.cache) if args.cache else None,
                 "cache_bytes_before": cache_before, "cache_bytes_after": cache_after,
                 "rep_totals_ms": [round(r["total_ms"], 1) for r in reps],
                 "repeats_identical": all(r["texts"] == reps[0]["texts"] for r in reps),
                 "pieces_differing_between_repeats": sum(len({r["texts"][i] for r in reps}) > 1
                                                         for i in range(len(pieces))),
                 "x_realtime_median": round(speech_s / (median["total_ms"] / 1000), 2)}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(run, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(run["ov"]))
    print(f"saved {args.out}")


def run_paced(args, audio: np.ndarray) -> None:
    """The live call (greedy, no timestamps) on one window per period, after a warm load."""
    with phase("load"):
        started = time.perf_counter()
        pipe = build(args.model, args.device, args.cache, args.static, False)
        load_s = time.perf_counter() - started
    config = generation_config(pipe, args.language, "none", 1)
    pieces = paced.windows(audio, args.paced, args.period)
    with phase("warmup"):
        pipe.generate(pieces[0], config)
    result = paced.run(lambda samples: pipe.generate(samples, config).texts[0], pieces, args.period)
    info = {"device": args.device, "load_s": round(load_s, 2), **{k: v for k, v in result.items() if k != "texts"}}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"paced": info, "texts": result["texts"]}, indent=1, ensure_ascii=False),
                        encoding="utf-8")
    print(f"paced: median {result['latency_ms_median']} ms, p95 {result['latency_ms_p95']} ms, "
          f"busy {result['busy_share']:.1%}, late {result['late_calls']}")


if __name__ == "__main__":
    main()
