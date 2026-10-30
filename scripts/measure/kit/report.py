"""Scores a set of runs and prints them side by side as Markdown tables."""

from dataclasses import asdict, dataclass

from . import accuracy, failures, speakers
from .runs import Reference, Run, Timeline, by_track, clip, clock
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
    # Pieces per Whisper decoding ("beam 5", "greedy").
    decodings: dict[str, int]
    failure_counts: failures.Failures
    accuracy_scores: accuracy.Accuracy | None
    speaker_scores: speakers.SpeakerScore | None

    @property
    def real_time_factor(self) -> float | None:
        return self.speech_s / self.time_s if self.time_s else None

    def as_dict(self) -> dict:
        """Every field, and the rates the properties compute."""
        data = asdict(self)
        data["real_time_factor"] = self.real_time_factor
        if self.accuracy_scores is not None:
            scores, fields = self.accuracy_scores, data["accuracy_scores"]
            fields["words"]["rate"] = scores.words.rate
            fields["characters"]["rate"] = scores.characters.rate
            for track, errors in scores.tracks.items():
                fields["tracks"][track]["rate"] = errors.rate
        return data


def score(run: Run, reference: Reference | None, timeline: Timeline | None, label: str = "") -> Scores:
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
        decodings=run.decodings(),
        failure_counts=failures.count(run.pieces),
        accuracy_scores=None if reference is None else accuracy.score(run, reference),
        speaker_scores=None if timeline is None else speakers.score(run, timeline),
    )


def reference_words(run: Run, reference: Reference) -> tuple[int, int]:
    """The reference's words in the run's span, and how many of them repeat what was just said."""
    tokens = [token for rows in by_track(clip(reference.rows, run.span_ms), run.tracks).values()
              for row in rows for token in words(row.text)]
    return len(tokens), failures.repeated_words(tokens)


def _decoded(counts: dict[str, int]) -> str:
    return ", ".join(f"{decoding} × {count}" for decoding, count in counts.items())


def decoding_warnings(runs: list[Run], names: list[str]) -> list[str]:
    """Runs whose pieces were decoded in more than one way, and runs of one setting that were decoded differently.
    The post-meeting pass turns greedy for the rest of the process when a beam's KV cache cannot be allocated, so a
    comparison could otherwise set beam search against greedy decoding unnoticed. A run without a record (Parakeet,
    or an output written before pieces recorded it) is left out."""
    warnings = []
    first_of: dict[str, tuple[str, dict[str, int]]] = {}
    for run, name in zip(runs, names):
        counts = run.decodings()
        if not counts:
            continue
        if len(counts) > 1:
            warnings.append(f"{name} decoded its pieces {_decoded(counts)}")
        first_name, first_counts = first_of.setdefault(run.setting, (name, counts))
        if set(first_counts) != set(counts):
            warnings.append(f"{first_name} decoded {_decoded(first_counts)}, but {name} {_decoded(counts)}")
    return warnings


def _rate(value: float | None) -> str:
    return "–" if value is None else f"{value:.3f}"


def table(rows: list[list[str]], header: list[str]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" if i == 0 else "---:" for i in range(len(header))) + "|"]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    return "\n".join(lines)


def summary(scores: list[Scores]) -> str:
    short = f"≥ {failures.SHORT_PIECE_MS / 1000:g} s → ≤ {failures.SHORT_OUTPUT_WORDS} words"
    header = ["setting", "words", "WER", "CER", "S/D/I", "lost stretches", short, "loops", "rows with hallucinations",
              "time s", "× real time", "speaker agreement", "rows with a turn change"]
    rows = []
    for s in scores:
        a, f, sp = s.accuracy_scores, s.failure_counts, s.speaker_scores
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
            "–" if s.real_time_factor is None else f"{s.real_time_factor:.1f}",
            "–" if sp is None else f"{sp.agreement:.3f}",
            "–" if sp is None else f"{sp.turn_rows} of {sp.rows}",
        ])
    return table(rows, header)


def deletions(scores: list[Scores]) -> str:
    header = ["setting", "missing words", "outside kept pieces", f"at a piece edge ({accuracy.EDGE_MS / 1000:g} s)",
              "inside a piece", "largest lost stretches"]
    rows = []
    for s in scores:
        if s.accuracy_scores is None:
            continue
        d = s.accuracy_scores.deletions
        largest = ", ".join(f"{x.words} at {x.track} {clock(x.start_ms)}" for x in d.lost_stretches[:3]) or "–"
        rows.append([s.setting, str(s.accuracy_scores.words.deletions), str(d.outside_pieces), str(d.at_piece_edges),
                     str(d.inside_pieces), largest])
    return table(rows, header)
