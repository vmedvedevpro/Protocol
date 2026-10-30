"""Scores a set of runs and prints them side by side as Markdown tables."""

from dataclasses import asdict, dataclass

from . import accuracy, failures, speakers
from .runs import Reference, Run, Timeline, by_track, clip
from .text import words


@dataclass
class Scores:
    setting: str
    model: str
    words: int
    time_s: float
    speech_s: float
    warmup_s: float
    optimized: bool
    failures: failures.Failures
    accuracy: accuracy.Accuracy | None
    speakers: speakers.SpeakerScore | None

    def as_dict(self) -> dict:
        return asdict(self)


def score(run: Run, reference: Reference | None, timelines: dict[str, Timeline] | None, label: str = "") -> Scores:
    """`label` names the run in the tables; its setting by default."""
    timing = run.timing
    return Scores(
        setting=label or run.setting,
        model=run.model,
        words=sum(len(words(row.text)) for row in clip(run.rows(), run.span_ms)),
        # Language detection is part of the pass; the VAD over whole tracks is not counted (it reads the whole
        # recording even for a span).
        time_s=(timing["detection_ms"] + timing["transcription_ms"]) / 1000,
        speech_s=timing["speech_ms"] / 1000,
        warmup_s=timing["warmup_ms"] / 1000,
        optimized=run.optimized,
        failures=failures.count(run.pieces),
        accuracy=None if reference is None else accuracy.score(run, reference),
        speakers=None if timelines is None else speakers.score(run, timelines),
    )


def reference_words(run: Run, reference: Reference) -> tuple[int, int]:
    """The reference's words in the run's span, and how many of them repeat what was just said."""
    tokens = [token for rows in by_track(clip(reference.rows, run.span_ms), run.tracks).values()
              for row in rows for token in words(row.text)]
    return len(tokens), failures.repeated_words(tokens)


def _rate(value: float | None) -> str:
    return "–" if value is None else f"{value:.3f}"


def table(rows: list[list[str]], header: list[str]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" if i == 0 else "---:" for i in range(len(header))) + "|"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def summary(scores: list[Scores]) -> str:
    header = ["setting", "words", "WER", "CER", "S/D/I", "lost stretches", "≥ 3 s → ≤ 2 words", "loops",
              "rows with hallucinations", "time s", "× real time", "speaker agreement", "rows with a turn change"]
    rows = []
    for s in scores:
        a, f, sp = s.accuracy, s.failures, s.speakers
        rows.append([
            s.setting,
            f"{s.words:,}",
            _rate(None if a is None else a.words.rate),
            _rate(None if a is None else a.characters.rate),
            "–" if a is None else f"{a.words.substitutions}/{a.words.deletions}/{a.words.insertions}",
            "–" if a is None else str(len(a.deletions.lost_stretches)),
            f"{f.short_outputs} of {f.pieces}",
            str(f.loops),
            str(f.hallucinated_rows),
            f"{s.time_s:.1f}",
            f"{s.speech_s / s.time_s:.1f}" if s.time_s else "–",
            "–" if sp is None else f"{sp.agreement:.3f}",
            "–" if sp is None else f"{sp.turn_rows} of {sp.rows}",
        ])
    return table(rows, header)


def _clock(ms: float) -> str:
    seconds = int(ms // 1000)
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def deletions(scores: list[Scores]) -> str:
    header = ["setting", "missing words", "outside kept pieces", "at a piece edge (2 s)", "inside a piece",
              "largest lost stretches"]
    rows = []
    for s in scores:
        if s.accuracy is None:
            continue
        d = s.accuracy.deletions
        largest = ", ".join(f"{x.words} at {x.track} {_clock(x.start_ms)}" for x in d.lost_stretches[:3]) or "–"
        rows.append([s.setting, str(s.accuracy.words.deletions), str(d.outside_pieces), str(d.at_piece_edges),
                     str(d.inside_pieces), largest])
    return table(rows, header)
