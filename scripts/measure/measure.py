"""Scores transcription measurements: the method is docs/MEASURING_TRANSCRIPTION.md.

    python scripts/measure/measure.py score OUT/post-meeting.json OUT/live.json --reference REF.json
    python scripts/measure/measure.py spotcheck OUT/post-meeting.json OUT/live.json --reference REF.json

The runs come from the Rust commands in frontend/src-tauri/src/measure/.
"""

import argparse
import json
import sys
from pathlib import Path

from kit import report, spotcheck
from kit.runs import load_diarization, load_reference, load_run

def labels(paths: list[Path], settings: list[str]) -> list[str]:
    """Each run's setting, with its folder when two runs share a setting (the same setting on two builds)."""
    return [f"{path.parent.name}/{setting}" if settings.count(setting) > 1 else setting
            for path, setting in zip(paths, settings)]


def score(args: argparse.Namespace) -> None:
    runs = [load_run(path) for path in args.runs]
    reference = load_reference(args.reference) if args.reference else None
    timelines = load_diarization(args.diarization) if args.diarization else None
    names = labels(args.runs, [run.setting for run in runs])
    scores = [report.score(run, reference, timelines, name) for run, name in zip(runs, names)]
    if reference is not None:
        total, repeated = report.reference_words(runs[0], reference)
        print(f"Reference: {total:,} words in the span, {repeated} of them repeating what was just said.\n")
    print(report.summary(scores))
    if reference is not None:
        print()
        print(report.deletions(scores))
    if not all(run.optimized for run in runs):
        print("\nA run comes from a debug build: compare times only between release builds.")
    if args.out:
        args.out.write_text(json.dumps([s.as_dict() for s in scores], ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"\nwrote {args.out}")


def spot_check(args: argparse.Namespace) -> None:
    runs = [load_run(path) for path in args.runs]
    reference = load_reference(args.reference) if args.reference else None
    text = spotcheck.passages(runs, reference, args.passages, args.seconds, args.seed)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
        print(f"wrote {args.out}")
    else:
        print(text)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(required=True)

    for name, command, help_text in (("score", score, "score runs side by side"),
                                     ("spotcheck", spot_check, "print passages of the runs side by side")):
        sub = commands.add_parser(name, help=help_text)
        sub.add_argument("runs", type=Path, nargs="+", help="<setting>.json files from one or more runs")
        sub.add_argument("--reference", type=Path, help="reference.json, or a human transcript in the same format")
        sub.add_argument("--out", type=Path, help="also write the output here")
        sub.set_defaults(command=command)
    scoring = commands.choices["score"]
    scoring.add_argument("--diarization", type=Path, help="diarization.json of the same run, for speaker scores")
    checking = commands.choices["spotcheck"]
    checking.add_argument("--passages", type=int, default=10)
    checking.add_argument("--seconds", type=float, default=25.0)
    checking.add_argument("--seed", type=int, default=75)

    args = parser.parse_args()
    args.command(args)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
