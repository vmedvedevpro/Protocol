"""Parakeet TDT 0.6B v3 (the app's INT8 ONNX files) on ONNX Runtime, with the encoder on a chosen device.

    python parakeet_ort.py --model DIR --encoder cpu|dml|ov-npu|ov-gpu|ov-cpu --pieces KIT_parakeet.json
                           --audio WAV --out RUN.json [--frames N] [--cache DIR] [--reps 3] [--profile]
    python parakeet_ort.py ... --paced 300 --period 6        (the live-like scenario instead of the pieces)
    python parakeet_ort.py ... --resident 120                (loaded and warm, no calls: the cost of staying open)
    python parakeet_ort.py ... --load-only                   (load and one call: a start, cold or warm)

`--passes N` (#80 round 2) makes each timed repeat N passes over the calls, so that a repeat lasts long enough for
its energy to stand out of the idle around it; every pass starts from the same planned windows (a retried window
does not carry over), its `audio_s` is N times the pieces' audio, and the texts are the last pass's.

The same steps as `parakeet_engine/model.rs`: the `nemo128` preprocessor and the decoder/joint on the CPU, the
encoder on `--encoder`, greedy TDT decoding (durations 0-4, at most 3 tokens per frame) and the same detokenising
rule. Runtime: onnxruntime-directml 1.24.4 (the app's ONNX Runtime release and build) with Intel's OpenVINO plugin
EP (`onnxruntime-ep-openvino`) registered into it for the `ov-*` encoders.

Static shapes: the NPU compiles one input shape. With `--frames N` the features are zero-padded to N frames (10 ms
each) and the encoder gets the true `length`; only `encoded_lengths` frames are decoded. Every piece then costs an
N-frame encoder call. The padding still changes the text: on the fixture's 6 s pieces it mostly changes the last
word, the one the VAD's cap cut, so `--frames` on the CPU gives the padding's own effect (`--pad wave` pads with
silence samples instead, which measured worse). DirectML also gains from one shape: it prepares its graph again
for every new input shape.

OpenVINO options go through the plugin's `load_config` file: its compile cache (`--cache`, OpenVINO's CACHE_DIR;
the plugin ignores its own `cache_dir` option) and `--ov-properties`.

Proof of placement: `--profile` writes ONNX Runtime's profile and counts the encoder's nodes and time per
execution provider; `ov-*` sessions also refuse any CPU fallback (`session.disable_cpu_ep_fallback`), so a session
that builds runs its whole encoder graph inside the OpenVINO EP.
"""

import argparse
import copy
import dataclasses
import json
import os
import re
import statistics
import time
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort

import chunking
import paced
from marks import phase

SAMPLES_PER_MS = 16
HOP = 160  # nemo128's hop: one feature frame per 10 ms, T = samples / 160 + 1
ENCODER_FRAME_MS = 80.0  # the encoder subsamples the features 8 times
DURATIONS = (0, 1, 2, 3, 4)
MAX_TOKENS_PER_STEP = 3
SPACES = re.compile(r"\A\s|\s\B|(\s)\b")


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav:
        assert wav.getframerate() == 16000 and wav.getnchannels() == 1 and wav.getsampwidth() == 2, path
        return np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def dir_bytes(path: Path | None) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path and path.exists() else 0


def cpu_options() -> ort.SessionOptions:
    """The app's CPU session: level-3 optimisation, parallel execution, memory pattern, no spinning (#70)."""
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    options.execution_mode = ort.ExecutionMode.ORT_PARALLEL
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return options


def openvino_devices() -> dict[str, object]:
    import onnxruntime_ep_openvino as ep
    library = os.path.join(os.path.dirname(ep.__file__), "onnxruntime_providers_openvino_plugin.dll")
    if not any(d.ep_name == "OpenVINOExecutionProvider" for d in ort.get_ep_devices()):
        ort.register_execution_provider_library("OpenVINOExecutionProvider", library)
    return {d.ep_metadata.get("ov_device"): d for d in ort.get_ep_devices()
            if d.ep_name == "OpenVINOExecutionProvider"}


def encoder_session(path: Path, encoder: str, frames: int | None, cache: Path | None, profile: Path | None,
                    ov_properties: dict | None = None):
    if encoder == "cpu":
        options = cpu_options()
        providers = ["CPUExecutionProvider"]
    else:
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.enable_mem_pattern = False
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
        providers = None
        if encoder == "dml":
            providers = [("DmlExecutionProvider", {"device_id": 0})]
        else:
            device = openvino_devices()[encoder.split("-")[1].upper()]
            ep_options = {}
            properties = dict(ov_properties or {})
            if cache is not None:
                # The plugin ignores `cache_dir` (it says so in a warning); OpenVINO's CACHE_DIR goes through
                # `load_config`, a JSON file of properties per OpenVINO device.
                cache.mkdir(parents=True, exist_ok=True)
                properties["CACHE_DIR"] = str(cache)
            if properties:
                config = (cache or path.parent).with_name((cache or path.parent).name + ".load_config.json")
                config.write_text(json.dumps({encoder.split("-")[1].upper(): properties}), encoding="utf-8")
                ep_options["load_config"] = str(config)
            if frames is not None:
                ep_options["reshape_input"] = f"audio_signal[1,128,{frames}],length[1]"
            options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
            options.add_provider_for_devices([device], ep_options)
    if profile is not None:
        options.enable_profiling = True
        options.profile_file_prefix = str(profile)
    if providers is None:
        return ort.InferenceSession(str(path), sess_options=options)
    return ort.InferenceSession(str(path), sess_options=options, providers=providers)


class Parakeet:
    def __init__(self, model: Path, encoder: str, frames: int | None, cache: Path | None, profile: Path | None,
                 ov_properties: dict | None = None, pad: str = "features"):
        self.frames = frames
        self.pad = pad
        self.preprocessor = ort.InferenceSession(str(model / "nemo128.onnx"), sess_options=cpu_options(),
                                                 providers=["CPUExecutionProvider"])
        self.decoder = ort.InferenceSession(str(model / "decoder_joint-model.int8.onnx"), sess_options=cpu_options(),
                                            providers=["CPUExecutionProvider"])
        started = time.perf_counter()
        self.encoder = encoder_session(model / "encoder-model.int8.onnx", encoder, frames, cache, profile, ov_properties)
        self.encoder_load_s = time.perf_counter() - started
        self.vocab, self.blank = self._vocab(model / "vocab.txt")
        shape = next(i.shape for i in self.decoder.get_inputs() if i.name == "input_states_1")
        self.state_shape = (shape[0], 1, shape[2])
        self.encoder_ms = 0.0

    @staticmethod
    def _vocab(path: Path) -> tuple[list[str], int]:
        pairs = [line.rstrip().rsplit(" ", 1) for line in path.read_text(encoding="utf-8").splitlines() if " " in line]
        vocab = [""] * (max(int(i) for _, i in pairs) + 1)
        blank = None
        for token, i in pairs:
            vocab[int(i)] = token.replace("▁", " ")
            if token == "<blk>":
                blank = int(i)
        return vocab, blank

    def transcribe(self, samples: np.ndarray) -> str:
        tokens, _ = self.transcribe_tokens(samples)
        text = "".join(self.vocab[i] for i in tokens)
        return SPACES.sub(lambda m: " " if m.group(1) else "", text)

    def transcribe_tokens(self, samples: np.ndarray) -> tuple[list[int], list[int]]:
        """The decoded tokens and the encoder frame (80 ms) each was emitted at."""
        if self.frames is not None and self.pad == "wave":
            # Silence after the speech, as if the piece went on quietly: the features and their normalisation
            # see it, and the encoder decodes all frames (the silence decodes as blanks).
            target = (self.frames - 1) * HOP
            assert len(samples) <= target, f"{len(samples)} samples > {target} for --frames {self.frames}"
            samples = np.pad(samples, (0, target - len(samples)))
        features, lens = self.preprocessor.run(None, {"waveforms": samples[None, :].astype(np.float32),
                                                      "waveforms_lens": np.array([len(samples)], dtype=np.int64)})
        if self.frames is not None and self.pad == "features":
            assert features.shape[2] <= self.frames, f"{features.shape[2]} feature frames > --frames {self.frames}"
            features = np.pad(features, ((0, 0), (0, 0), (0, self.frames - features.shape[2])))
        started = time.perf_counter()
        encoded, encoded_lens = self.encoder.run(None, {"audio_signal": features, "length": lens})
        self.encoder_ms += (time.perf_counter() - started) * 1000.0
        return self._decode(encoded[0].T, int(encoded_lens[0]))

    def _decode(self, frames: np.ndarray, count: int) -> tuple[list[int], list[int]]:
        state1 = np.zeros(self.state_shape, dtype=np.float32)
        state2 = np.zeros(self.state_shape, dtype=np.float32)
        tokens: list[int] = []
        at: list[int] = []
        t = emitted = 0
        vocab_size = len(self.vocab)
        while t < count:
            target = tokens[-1] if tokens else self.blank
            logits, new1, new2 = self.decoder.run(
                ["outputs", "output_states_1", "output_states_2"],
                {"encoder_outputs": frames[t][None, :, None], "targets": np.array([[target]], dtype=np.int32),
                 "target_length": np.array([1], dtype=np.int32), "input_states_1": state1, "input_states_2": state2})
            logits = logits.reshape(-1)
            token = int(np.argmax(logits[:vocab_size]))
            if token != self.blank:
                state1, state2 = new1, new2
                tokens.append(token)
                at.append(t)
                emitted += 1
            skip = DURATIONS[int(np.argmax(logits[vocab_size:]))] if logits.size > vocab_size else 1
            if skip == 0 and (token == self.blank or emitted >= MAX_TOKENS_PER_STEP):
                skip = 1
            if skip > 0:
                t += skip
                emitted = 0
        return tokens, at


def profile_summary(path: str) -> dict:
    """Nodes and time per execution provider among the encoder's node events."""
    events = json.loads(Path(path).read_text(encoding="utf-8"))
    per: dict[str, dict] = {}
    for event in events:
        if event.get("cat") != "Node" or not event.get("name", "").endswith("_kernel_time"):
            continue
        provider = event.get("args", {}).get("provider", "?")
        entry = per.setdefault(provider, {"nodes": set(), "us": 0, "ops": set()})
        entry["nodes"].add(event["name"])
        entry["us"] += event.get("dur", 0)
        entry["ops"].add(event.get("args", {}).get("op_name", "?"))
    return {p: {"nodes": len(e["nodes"]), "ms": round(e["us"] / 1000, 1), "ops": sorted(e["ops"])[:40]}
            for p, e in per.items()}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--encoder", required=True, choices=("cpu", "dml", "ov-npu", "ov-gpu", "ov-cpu"))
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--pieces", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--frames", type=int)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--profile", type=Path)
    parser.add_argument("--paced", type=float)
    parser.add_argument("--period", type=float, default=6.0)
    parser.add_argument("--resident", type=float, help="load, warm up, then only wait this many seconds")
    parser.add_argument("--resident-settle", type=float, default=0.0,
                        help="with --resident: seconds after the warm-up that are not part of the resident phase")
    parser.add_argument("--pad", choices=("features", "wave"), default="features",
                        help="features: zero features after the speech, masked by `length`; wave: silence samples")
    parser.add_argument("--chunking", choices=("pieces", "span", "overlap"), default="pieces",
                        help="batch only, with --frames: which audio each call sees (chunking.py)")
    parser.add_argument("--span-s", type=float, default=5.0)
    parser.add_argument("--hop-s", type=float, default=4.0)
    parser.add_argument("--retry-words-per-s", type=float, default=0.0,
                        help="overlap: run a window again 0.5 s later when it yields fewer words per second")
    parser.add_argument("--snap-s", type=float, default=0.0,
                        help="overlap: start each window at the quietest 20 ms within this many seconds")
    parser.add_argument("--merge", choices=("anchor", "midpoint"), default="anchor",
                        help="overlap: where two calls' words are joined (chunking.py)")
    parser.add_argument("--passes", type=int, default=1, help="passes over the calls in each timed repeat")
    parser.add_argument("--load-only", action="store_true", help="load and one call (warm-up), nothing timed after")
    parser.add_argument("--ov-properties", type=json.loads, help='OpenVINO properties, e.g. {"INFERENCE_PRECISION_HINT": "f32"}')
    args = parser.parse_args()

    audio = read_wav(args.audio)
    cache_before = dir_bytes(args.cache)
    with phase("load", cache_bytes_before=cache_before) as mark:
        started = time.perf_counter()
        model = Parakeet(args.model, args.encoder, args.frames, args.cache, args.profile, args.ov_properties, args.pad)
        load_s = time.perf_counter() - started
        cache_after = dir_bytes(args.cache)
        mark.update(cache_bytes_after=cache_after, load_s=round(load_s, 2),
                    encoder_load_s=round(model.encoder_load_s, 2))
    info = {"encoder": args.encoder, "frames": args.frames, "pad": args.pad, "ov_properties": args.ov_properties, "ort": ort.__version__, "load_s": round(load_s, 2),
            "encoder_load_s": round(model.encoder_load_s, 2), "cache_dir": str(args.cache) if args.cache else None,
            "cache_bytes_before": cache_before, "cache_bytes_after": cache_after,
            "encoder_providers": model.encoder.get_providers()}
    print(f"load {load_s:.1f} s (encoder {model.encoder_load_s:.1f} s), cache {cache_before / 1e6:.0f} -> "
          f"{cache_after / 1e6:.0f} MB, providers {info['encoder_providers']}")

    if args.resident:
        # The engine loaded and warm but not called: what keeping it open costs between a meeting's calls.
        with phase("warmup"):
            model.transcribe(audio[:6 * 16000])
        if args.resident_settle:
            # The device's tail after the warm-up call belongs to the call, not to staying open (#80).
            with phase("resident-settle", seconds=args.resident_settle):
                time.sleep(args.resident_settle)
        with phase("resident", seconds=args.resident, encoder=args.encoder):
            time.sleep(args.resident)
        return
    if args.paced:
        pieces = paced.windows(audio, args.paced, args.period)
        with phase("warmup"):
            model.transcribe(pieces[0])
        result = paced.run(model.transcribe, pieces, args.period)
        info.update({k: v for k, v in result.items() if k != "texts"})
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({"paced": info, "texts": result["texts"]}, indent=1, ensure_ascii=False),
                            encoding="utf-8")
        print(f"paced: median {result['latency_ms_median']} ms, p95 {result['latency_ms_p95']} ms, "
              f"busy {result['busy_share']:.1%}, late {result['late_calls']}")
        return

    kit = json.loads(args.pieces.read_text(encoding="utf-8"))
    pieces = [p for p in kit["pieces"] if p["skipped"] is None]
    speech_s = sum(p["end_ms"] - p["start_ms"] for p in pieces) / 1000.0
    # The window a call fills: the static shape, or without one the same 6.07 s, so that the chunking's own effect
    # can be measured apart from the padding's.
    window_s = ((args.frames or 608) - 1) * HOP / 16000.0
    frame = 20 * SAMPLES_PER_MS
    rms = np.sqrt(np.mean(audio[:len(audio) // frame * frame].reshape(-1, frame) ** 2, axis=1))
    planned = chunking.plan(pieces, args.chunking, window_s, args.span_s, args.hop_s,
                            lambda ms: float(rms[min(int(ms // 20), len(rms) - 1)]), args.snap_s)
    windows = list(planned)
    samples = [audio[int(w.start_ms * SAMPLES_PER_MS):int(w.end_ms * SAMPLES_PER_MS)] for w in windows]
    stretch_ends = [end for _, end in chunking.stretches(pieces)]
    print(f"{len(pieces)} pieces, {speech_s:.1f} s; {len(windows)} calls ({args.chunking}); longest "
          f"{max(len(s) for s in samples) / 16000:.2f} s")

    with phase("warmup") as mark:
        started = time.perf_counter()
        model.transcribe(samples[0])
        warmup_s = time.perf_counter() - started
        mark.update(warmup_s=round(warmup_s, 2))
    if args.load_only:
        print(f"load {load_s:.2f} s, first call {warmup_s:.2f} s")
        return
    reps = []
    for rep in range(1, args.reps + 1):
        model.encoder_ms = 0.0
        total_ms = 0.0
        with phase(f"rep{rep}", audio_s=speech_s * args.passes, passes=args.passes):
            for _ in range(args.passes):
                walls, texts = [], []
                windows = list(planned)
                decoded, retried = [], []
                for index, (window, piece_samples) in enumerate(zip(windows, samples)):
                    started = time.perf_counter()
                    tokens, frames = model.transcribe_tokens(piece_samples)
                    found = chunking.words(model.vocab, tokens, frames, window.start_ms, ENCODER_FRAME_MS)
                    # TDT now and then emits nothing for a whole window of continuous speech (#80): a window of a
                    # stretch with fewer words per second than --retry-words-per-s runs again 0.5 s later (earlier
                    # at the stretch's end), and the call with more words stays.
                    seconds = (window.end_ms - window.start_ms) / 1000.0
                    if args.chunking == "overlap" and args.retry_words_per_s and seconds >= 4.0                         and len(found) < args.retry_words_per_s * seconds:
                        end = stretch_ends[window.stretch]
                        shift = 500.0 if window.end_ms + 500.0 <= end else -500.0
                        moved = dataclasses.replace(window, start_ms=window.start_ms + shift, end_ms=window.end_ms + shift)
                        tokens, frames = model.transcribe_tokens(
                            audio[int(moved.start_ms * SAMPLES_PER_MS):int(moved.end_ms * SAMPLES_PER_MS)])
                        again = chunking.words(model.vocab, tokens, frames, moved.start_ms, ENCODER_FRAME_MS)
                        retried.append({"start_ms": round(window.start_ms), "words": len(found), "shift_ms": shift,
                                        "words_after": len(again)})
                        if len(again) > len(found):
                            found, windows[index] = again, moved
                    walls.append((time.perf_counter() - started) * 1000.0)
                    decoded.append(found)
                    if args.chunking == "pieces":
                        text = "".join(model.vocab[i] for i in tokens)
                        texts.append(SPACES.sub(lambda m: " " if m.group(1) else "", text))
                total_ms += sum(walls)
                if args.chunking != "pieces":
                    kept, junctions = chunking.merge(windows, decoded, "keep" if args.chunking == "span" else args.merge)
                    texts = chunking.assign(pieces, kept)
                    # A piece's share of the calls' time, by the length of audio it kept.
                    share = [(p["end_ms"] - p["start_ms"]) / (speech_s * 1000.0) for p in pieces]
                    walls = [sum(walls) * f for f in share]
        reps.append({"walls": walls, "texts": texts, "total_ms": total_ms, "encoder_ms": model.encoder_ms,
                     "calls": len(windows), "junctions": junctions if args.chunking != "pieces" else None,
                     "retried": retried,
                     "windows": [{"start_ms": round(w.start_ms), "end_ms": round(w.end_ms), "stretch": w.stretch,
                                  "words": [(round(at), text) for at, text in words]}
                                 for w, words in zip(windows, decoded)] if args.chunking != "pieces" else None})
        print(f"rep{rep}: {total_ms / 1000:.2f} s ({speech_s * args.passes / (total_ms / 1000):.1f}x), "
              f"encoder {model.encoder_ms / 1000:.2f} s")
    median = sorted(reps, key=lambda r: r["total_ms"])[len(reps) // 2]
    if args.profile:
        info["profile"] = profile_summary(model.encoder.end_profiling())

    run = copy.deepcopy(kit)
    run["model"] = f"{args.model.name} (ONNX Runtime {ort.__version__})"
    run["acceleration"] = {"cpu": "CPU", "dml": "DirectML encoder", "ov-npu": "OpenVINO EP NPU encoder",
                           "ov-gpu": "OpenVINO EP GPU encoder", "ov-cpu": "OpenVINO EP CPU encoder"}[args.encoder]
    order = iter(range(len(pieces)))
    for piece in run["pieces"]:
        if piece["skipped"] is not None:
            continue
        i = next(order)
        text = reps[-1]["texts"][i].strip()
        piece["wall_ms"] = round(median["walls"][i], 1)
        piece["dropped"] = False
        piece["rows"] = [{"start_ms": piece["start_ms"], "end_ms": piece["end_ms"], "text": text, "speakers": None}] \
            if text else []
    run["timing"] = dict(kit["timing"], transcription_ms=round(median["total_ms"] / args.passes, 1),
                         warmup_ms=round(warmup_s * 1000, 1),
                         speech_ms=round(speech_s * 1000, 1))
    info.update(chunking=args.chunking, calls=len(windows), span_s=args.span_s if args.chunking == "span" else None,
                hop_s=args.hop_s if args.chunking == "overlap" else None,
                merge=args.merge if args.chunking == "overlap" else None, junctions=reps[-1]["junctions"],
                snap_s=args.snap_s if args.chunking == "overlap" else None, windows=reps[-1]["windows"],
                retry_words_per_s=args.retry_words_per_s if args.chunking == "overlap" else None,
                retried=reps[-1]["retried"],
                rep_totals_ms=[round(r["total_ms"], 1) for r in reps],
                encoder_ms=[round(r["encoder_ms"], 1) for r in reps],
                repeats_identical=all(r["texts"] == reps[0]["texts"] for r in reps),
                passes=args.passes, x_realtime_median=round(speech_s * args.passes / (median["total_ms"] / 1000), 2))
    run["ort"] = info
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(run, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in info.items() if k != "profile"}))
    print(json.dumps(info.get("profile", {}))[:2000])
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
