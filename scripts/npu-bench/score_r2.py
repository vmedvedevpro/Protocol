"""Accuracy of Whisper against Parakeet for #80 round 2: every file's runs scored with the kit (`kit.report`, the
kit's normaliser for both models), plus a WER without fillers for the AMI files.

    python score_r2.py --runs .measure/runs/80/r2-acc --out .measure/runs/80/r2-acc/scores.json
    python score_r2.py --batch .measure/runs/80/r2-wb .measure/runs/80/r2-pb --out .measure/runs/80/r2-batch-wer.json

`--batch` scores every timed run of the batch cells (one folder per run, the text of its last pass) against
fleurs-ru, the audio those cells transcribe; the decoding is deterministic, so the repeats of one feed and device
should agree, and the output says whether they do.

Per file (`<runs>/<file>/`): Whisper on the GPU (`wh-gpu/live.json`, `wh-gpu/post-meeting.json`), Parakeet on the
NPU with feed B (`pk-npu-b/parakeet.json`), the product today (the kit's `kit/rep1/`: Parakeet on the CPU, and
whisper.cpp's live and post-meeting runs). fleurs-ru takes the product's pieces and runs of #66 and round 1.

The AMI references keep the fillers the annotators heard (um, uh, mm-hmm: about one word in twenty); Whisper
leaves most of them out, so its deletions there say little about what a reader of the transcript loses. The
filler-free WER drops those tokens from both sides after the kit's normalisation and aligns again.
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/measure"))
from kit import accuracy, report  # noqa: E402
from kit.runs import by_track, clip, load_reference, load_run  # noqa: E402
from kit.text import normalize  # noqa: E402

FILES = {"fleurs-ru": "ru", "fleurs-en": "en", "ami-es2004a-mix": "en", "ami-es2004a-sdm": "en", "golos-farfield": "ru",
         "cv-sps-ru": "ru"}
FILLERS = {"um", "uh", "uhm", "umm", "mm", "mmm", "hmm", "hm", "mhm", "ah", "eh", "er", "erm", "huh"}
FLEURS_RU = {"kit-live": ".measure/runs/66/vulkan-q5_0/rep1/live.json",
             "kit-post-meeting": ".measure/runs/66/vulkan-q5_0/rep1/post-meeting.json",
             "kit-parakeet": ".measure/runs/66/kit-parakeet-cpu/rep1/parakeet.json"}


def runs_of(base: Path, name: str) -> dict[str, Path]:
    folder = base / name
    found = {"whisper-gpu-live": folder / "wh-gpu/live.json",
             "whisper-gpu-post": folder / "wh-gpu/post-meeting.json",
             "parakeet-npu-b": folder / "pk-npu-b/parakeet.json"}
    if name == "fleurs-ru":
        found.update({k: ROOT / v for k, v in FLEURS_RU.items()})
    else:
        found.update({"kit-live": folder / "kit/rep1/live.json",
                      "kit-post-meeting": folder / "kit/rep1/post-meeting.json",
                      "kit-parakeet": folder / "kit/rep1/parakeet.json"})
    for device in ("gpu", "npu"):
        for feed in ("a", "b"):
            path = folder / f"pk-{device}-{feed}/parakeet.json"
            if path.exists():
                found[f"parakeet-{device}-{feed}"] = path
    return {k: v for k, v in found.items() if v.exists()}


def without_fillers(run, reference) -> dict:
    """WER after dropping filler tokens from both normalised texts, track by track."""
    expected = by_track(clip(reference.rows, run.span_ms), run.tracks)
    produced = by_track(clip(run.rows(), run.span_ms), run.tracks)
    total = accuracy.Errors(0)
    for track in run.tracks:
        ref = [w for w in normalize(" ".join(r.text for r in expected[track])).split() if w not in FILLERS]
        out = [w for w in normalize(" ".join(r.text for r in produced[track])).split() if w not in FILLERS]
        total += accuracy.word_errors(ref, out)[0]
    return {"wer": total.rate, "s_d_i": [total.substitutions, total.deletions, total.insertions],
            "words": total.reference}


def entry_of(path: Path, run, reference, label: str) -> dict:
    scores = report.score(run, reference, None, label)
    a = scores.accuracy_scores
    # Where the deleted reference words lay against the pieces the pass kept: outside every piece means the VAD
    # never gave that speech to the model; inside a piece means the model heard it and left it out.
    return {"path": str(path), "wer": a.words.rate, "cer": a.characters.rate,
            "s_d_i": [a.words.substitutions, a.words.deletions, a.words.insertions],
            "reference_words": a.words.reference, "lost_stretches": len(a.deletions.lost_stretches),
            "lost_stretch_words": sum(s.words for s in a.deletions.lost_stretches),
            "deleted_outside_pieces": a.deletions.outside_pieces, "deleted_at_piece_edges": a.deletions.at_piece_edges,
            "deleted_inside_pieces": a.deletions.inside_pieces,
            "x_realtime": scores.real_time_factor, "pieces": len(run.pieces)}


def batch(cells: list[Path]) -> dict:
    """WER of every timed run in the batch cells against fleurs-ru, grouped by feed and device (`wh-live-gpu-3` ->
    `wh-live-gpu`)."""
    reference = load_reference(ROOT / ".measure/fixtures/fleurs-ru/reference.json")
    groups: dict[str, list[dict]] = {}
    for cell in cells:
        for path in sorted(cell.glob("*/*.json")):
            name = path.parent.name
            entry = entry_of(path, load_run(path), reference, name)
            entry["run"] = name
            groups.setdefault(name.rsplit("-", 1)[0], []).append(entry)
    out = {}
    for group, entries in groups.items():
        out[group] = {"wer": entries[0]["wer"], "cer": entries[0]["cer"], "s_d_i": entries[0]["s_d_i"],
                      "reference_words": entries[0]["reference_words"],
                      "lost_stretches": entries[0]["lost_stretches"],
                      "repeats": len(entries),
                      "repeats_agree": all(e["s_d_i"] == entries[0]["s_d_i"] for e in entries),
                      "runs": entries}
        print(f"  {group:<16} WER {entries[0]['wer']:.3f}  CER {entries[0]['cer']:.3f}  S/D/I {entries[0]['s_d_i']}  "
              f"repeats {len(entries)} agree {out[group]['repeats_agree']}")
    return out


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", type=Path)
    parser.add_argument("--batch", type=Path, nargs="+")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    if not args.runs and not args.batch:
        parser.error("give --runs or --batch")
    if args.batch:
        args.out.write_text(json.dumps(batch(args.batch), indent=1, ensure_ascii=False), encoding="utf-8")
        print(f"\nwrote {args.out}")
        return
    out = {}
    for name in FILES:
        reference_path = ROOT / ".measure/fixtures" / name / "reference.json"
        found = runs_of(args.runs, name)
        if not found or not reference_path.exists():
            continue
        reference = load_reference(reference_path)
        rows = {}
        print(f"\n{name}")
        for label, path in found.items():
            run = load_run(path)
            entry = entry_of(path, run, reference, label)
            if name.startswith("ami"):
                entry["no_fillers"] = without_fillers(run, reference)
            rows[label] = entry
            extra = f"  no fillers {entry['no_fillers']['wer']:.3f}" if "no_fillers" in entry else ""
            print(f"  {label:<20} WER {entry['wer']:.3f}  CER {entry['cer']:.3f}  S/D/I {entry['s_d_i']}  "
                  f"lost {entry['lost_stretches']} ({entry['lost_stretch_words']} words){extra}")
        out[name] = rows
    args.out.write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
