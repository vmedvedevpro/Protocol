"""Where the AMI deletions of #80 round 2 fall, by the kit's own alignment (`accuracy.word_errors`):

    python ami_overlap.py [--runs .measure/runs/80/r2-acc]

Each reference word goes to one bucket: outside every piece the run kept (the VAD never gave that speech to the
model), a filler, overlapped speech (another speaker's reference row covers the word's time), or one speaker. The
word's time is the kit's even spread over its row (`row_word_times`), so the overlap test is as precise as the rows
are short. The kit's `Row` keeps no speaker, so the speakers come from the reference file itself.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/measure"))
from kit import accuracy  # noqa: E402
from kit.runs import by_track, clip, load_reference, load_run  # noqa: E402
from kit.text import normalize  # noqa: E402

from score_r2 import FILLERS  # noqa: E402

RUNS = {"whisper-gpu-live": "wh-gpu/live.json", "whisper-gpu-post": "wh-gpu/post-meeting.json",
        "parakeet-npu-b": "pk-npu-b/parakeet.json", "kit-parakeet": "kit/rep1/parakeet.json"}
BUCKETS = ("outside", "overlap", "single", "filler")


def buckets(run, reference_path: Path) -> dict[str, list[int]]:
    """Per bucket: [reference words, of them deleted]."""
    reference = load_reference(reference_path)
    raw = json.loads(reference_path.read_text(encoding="utf-8"))["rows"]
    speaker = {(r["start_ms"], r["end_ms"], r["text"]): r["speaker"] for r in raw}
    who = lambda row: speaker.get((row.start_ms, row.end_ms, row.text))  # noqa: E731
    expected = by_track(clip(reference.rows, run.span_ms), run.tracks)
    produced = by_track(clip(run.rows(), run.span_ms), run.tracks)
    out = {k: [0, 0] for k in BUCKETS}
    for track in run.tracks:
        rows = expected[track]
        times, overlapped = [], []
        for row in rows:
            for t in accuracy.row_word_times(row):
                times.append(t)
                overlapped.append(any(o is not row and who(o) != who(row) and o.start_ms <= t <= o.end_ms
                                      for o in rows))
        ref = normalize(" ".join(r.text for r in rows)).split()
        hyp = normalize(" ".join(r.text for r in produced[track])).split()
        assert len(ref) == len(times)
        _, deleted = accuracy.word_errors(ref, hyp)
        gone = {i for start, end in deleted for i in range(start, end)}
        kept = [p for p in run.pieces if p.track == track and p.kept]
        for i, word in enumerate(ref):
            inside = any(p.start_ms <= times[i] <= p.end_ms for p in kept)
            key = ("outside" if not inside else "filler" if word in FILLERS
                   else "overlap" if overlapped[i] else "single")
            out[key][0] += 1
            out[key][1] += i in gone
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=Path, default=ROOT / ".measure/runs/80/r2-acc")
    args = parser.parse_args()
    for name in ("ami-es2004a-mix", "ami-es2004a-sdm"):
        print(f"== {name}")
        for label, rel in RUNS.items():
            path = args.runs / name / rel
            if not path.exists():
                continue
            found = buckets(load_run(path), ROOT / ".measure/fixtures" / name / "reference.json")
            parts = "  ".join(f"{k} {d}/{n} ({100 * d / n:.0f} %)" for k, (n, d) in found.items() if n)
            print(f"  {label:<18} {parts}")


if __name__ == "__main__":
    main()
