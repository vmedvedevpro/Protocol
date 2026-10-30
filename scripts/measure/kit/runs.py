"""The JSON files the kit reads.

A run (`<setting>.json`) and a model reference (`reference.json`) come from the Rust commands in
`frontend/src-tauri/src/measure/` (their format is `output.rs`). A human reference is `{"rows": [...]}` with the same
row fields; a row without "track" belongs to the recording's only track. Times are ms from the start of the recording.
"""

import json
from dataclasses import dataclass
from pathlib import Path

FORMAT = 1


@dataclass(frozen=True)
class Row:
    track: str | None
    start_ms: float
    end_ms: float
    text: str
    # The diarized speakers the app gives the row, its main speaker first; None on a track without a timeline.
    speakers: tuple[int, ...] | None = None


@dataclass(frozen=True)
class Piece:
    track: str
    start_ms: float
    end_ms: float
    skipped: str | None
    dropped: bool
    wall_ms: float
    rows: tuple[Row, ...]

    @property
    def transcribed(self) -> bool:
        return self.skipped is None

    @property
    def kept(self) -> bool:
        """Whether the pass stores the piece's rows (it was transcribed and not dropped as a hallucination)."""
        return self.transcribed and not self.dropped

    @property
    def text(self) -> str:
        return " ".join(row.text for row in self.rows)


@dataclass(frozen=True)
class Run:
    setting: str
    model: str
    language: str
    optimized: bool
    span_ms: tuple[float, float] | None
    tracks: tuple[str, ...]
    timing: dict[str, float]
    pieces: tuple[Piece, ...]

    def rows(self) -> list[Row]:
        """The rows the pass stores."""
        return [row for piece in self.pieces if piece.kept for row in piece.rows]


@dataclass(frozen=True)
class Turn:
    start_ms: float
    end_ms: float
    speaker: int


@dataclass(frozen=True)
class Timeline:
    """One track's diarized speakers over [start_ms, end_ms)."""

    track: str
    start_ms: float
    end_ms: float
    turns: tuple[Turn, ...]


def _read(path: Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("format", FORMAT) != FORMAT:
        raise ValueError(f"{path} has format {data['format']}; this scoring reads format {FORMAT}")
    return data


def _row(data: dict, track: str | None) -> Row:
    speakers = data.get("speakers")
    return Row(track=data.get("track", track), start_ms=data["start_ms"], end_ms=data["end_ms"], text=data["text"],
               speakers=None if speakers is None else tuple(speakers))


def _piece(data: dict) -> Piece:
    return Piece(track=data["track"], start_ms=data["start_ms"], end_ms=data["end_ms"], skipped=data["skipped"],
                 dropped=data["dropped"], wall_ms=data["wall_ms"],
                 rows=tuple(_row(row, data["track"]) for row in data["rows"]))


def load_run(path: Path) -> Run:
    data = _read(path)
    span = data.get("span_ms")
    return Run(setting=data["setting"], model=data["model"], language=data["language"], optimized=data["optimized"],
               span_ms=None if span is None else (span[0], span[1]),
               tracks=tuple(track["label"] for track in data["tracks"]), timing=data["timing"],
               pieces=tuple(_piece(piece) for piece in data["pieces"]))


def load_reference(path: Path) -> list[Row]:
    """A reference's rows: a model reference's stored rows, or a human transcript's rows."""
    data = _read(path)
    if "pieces" in data:
        return load_run(path).rows()
    return [_row(row, None) for row in data["rows"]]


def load_diarization(path: Path) -> dict[str, Timeline]:
    data = _read(path)
    return {
        track["track"]: Timeline(track=track["track"], start_ms=track["start_ms"], end_ms=track["end_ms"],
                                 turns=tuple(Turn(t["start_ms"], t["end_ms"], t["speaker"]) for t in track["segments"]))
        for track in data["tracks"]
    }


def in_span(rows: list[Row], span_ms: tuple[float, float] | None) -> list[Row]:
    """The rows that start inside the span, as the run's pieces do."""
    if span_ms is None:
        return list(rows)
    return [row for row in rows if span_ms[0] <= row.start_ms < span_ms[1]]


def by_track(rows: list[Row], tracks: tuple[str, ...]) -> dict[str, list[Row]]:
    """Rows per track in time order. A row without a track belongs to the only track."""
    grouped: dict[str, list[Row]] = {track: [] for track in tracks}
    for row in rows:
        track = row.track
        if track is None:
            if len(tracks) != 1:
                raise ValueError(f"a reference row has no track, and the run has {len(tracks)} tracks")
            track = tracks[0]
        if track in grouped:
            grouped[track].append(row)
    for track_rows in grouped.values():
        track_rows.sort(key=lambda row: row.start_ms)
    return grouped
