"""Passages of a recording with each run's rows and the reference's side by side, for a person to read.

Numbers say how much differs, not what: a spot check shows whether the words a setting loses matter. It quotes the
transcripts, so for a private recording its output stays outside the repository.
"""

import random

from .runs import Row, Run, in_span


def _clock(ms: float) -> str:
    seconds = int(ms // 1000)
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _rows_between(rows: list[Row], track: str, start_ms: float, end_ms: float) -> list[Row]:
    return sorted((row for row in rows if (row.track in (track, None)) and row.end_ms > start_ms
                   and row.start_ms < end_ms and row.text.strip()), key=lambda row: row.start_ms)


def passages(runs: list[Run], reference: list[Row] | None, count: int, seconds: float, seed: int) -> str:
    """`count` passages of `seconds`, each on a track and at a start drawn with `random.Random(seed)` over the first
    run's pieces, drawn again where the first run has no rows."""
    first = runs[0]
    pieces = [piece for piece in first.pieces if piece.kept]
    if not pieces:
        return "The first run has no rows."
    begin, end = min(p.start_ms for p in pieces), max(p.end_ms for p in pieces)
    length_ms = seconds * 1000
    rng = random.Random(seed)
    sources = [(run.setting, run.rows()) for run in runs]
    if reference is not None:
        sources.append(("reference", in_span(reference, first.span_ms)))
    lines = [f"# Spot check: {count} passages of {seconds:g} s, random.Random({seed})", ""]
    found = 0
    for _ in range(100 * count):
        if found == count:
            break
        track = rng.choice(first.tracks)
        start = rng.uniform(begin, max(begin, end - length_ms))
        if not _rows_between(sources[0][1], track, start, start + length_ms):
            continue
        found += 1
        lines += [f"## {found}. {track}, {_clock(start)}–{_clock(start + length_ms)}", ""]
        for name, rows in sources:
            lines += [f"**{name}**", ""]
            lines += [f"- [{_clock(r.start_ms)}–{_clock(r.end_ms)}] {r.text.strip()}"
                      for r in _rows_between(rows, track, start, start + length_ms)]
            lines.append("")
    return "\n".join(lines)
