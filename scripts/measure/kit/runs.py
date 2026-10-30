"""The JSON files the kit reads.

A run (`<setting>.json`), a model reference (`reference.json`) and a speaker timeline (`diarization.json`) come
from the Rust commands in `frontend/src-tauri/src/measure/` (their format is `output.rs`). A human reference is
`{"rows": [...]}` with the same row fields; a row without "track" belongs to the recording's only track. Times are
ms from the start of the recording.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from .text import words

FORMAT = 1


@dataclass(frozen=True)
class Row:
    track: str | None
    start_ms: float
    end_ms: float
    text: str
    # The diarized speakers of the row on the recording's timeline, the main one first and the others in index
    # order (the app sorts them); None when the run was not diarized.
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
    # The Whisper decoding of the call ("beam 5", "greedy"); None for Parakeet and skipped pieces.
    decoding: str | None = None

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
class Audio:
    """The file a track was decoded from: its name, size and SHA-256."""
    track: str
    file: str
    bytes: int
    sha256: str


@dataclass(frozen=True)
class Run:
    setting: str
    model: str
    language: str
    optimized: bool
    # The span measured; the pieces are those that reach into it, whole.
    span_ms: tuple[float, float] | None
    tracks: tuple[str, ...]
    timing: dict[str, float]
    pieces: tuple[Piece, ...]
    # The vocabulary's SHA-256, not its text, which can be private; None without a vocabulary.
    vocabulary: str | None = None
    audio: tuple[Audio, ...] = ()

    def rows(self) -> list[Row]:
        """The rows the pass stores."""
        return [row for piece in self.pieces if piece.kept for row in piece.rows]

    def decodings(self) -> dict[str, int]:
        """How many pieces each Whisper decoding transcribed."""
        counts: dict[str, int] = {}
        for piece in self.pieces:
            if piece.decoding is not None:
                counts[piece.decoding] = counts.get(piece.decoding, 0) + 1
        return counts


@dataclass(frozen=True)
class Reference:
    rows: list[Row]
    # A model reference's own run (`build_reference`), with the span, language and vocabulary it was built with;
    # None for a human reference.
    made_by: Run | None = None

    def check(self, run: Run) -> None:
        """Refuses a model reference built from other audio, one that does not cover the run's span, and one built
        with another language or vocabulary: the vocabulary mostly changes names, which is the size of the
        differences a comparison has to resolve."""
        made = self.made_by
        if made is None:
            return
        if made.audio != run.audio:
            raise ValueError(f"the reference was built from {_audio(made)}, the {run.setting} run from {_audio(run)}")
        if made.span_ms is not None and (run.span_ms is None or run.span_ms[0] < made.span_ms[0]
                                         or run.span_ms[1] > made.span_ms[1]):
            raise ValueError(f"the reference covers {_span(made.span_ms)}, the {run.setting} run {_span(run.span_ms)}")
        if made.language != run.language:
            raise ValueError(f"the reference was built with the language {made.language}, the {run.setting} run "
                             f"with {run.language}")
        if made.vocabulary != run.vocabulary:
            raise ValueError(f"the reference was built {_vocabulary(made)}, the {run.setting} run {_vocabulary(run)}")


def check_side_by_side(runs: list[Run], names: list[str]) -> None:
    """Refuses runs that cannot be compared: made from other audio, or over another span."""
    first, first_name = runs[0], names[0]
    for run, name in zip(runs[1:], names[1:]):
        if run.audio != first.audio:
            raise ValueError(f"{first_name} was made from {_audio(first)}, {name} from {_audio(run)}")
        if run.span_ms != first.span_ms:
            raise ValueError(f"{first_name} measures {_span(first.span_ms)}, {name} {_span(run.span_ms)}")


def _audio(run: Run) -> str:
    return ", ".join(f"{audio.file} ({audio.bytes:,} bytes, SHA-256 {audio.sha256[:12]}…)" for audio in run.audio)


def _span(span_ms: tuple[float, float] | None) -> str:
    return "the whole recording" if span_ms is None else f"{clock(span_ms[0])}–{clock(span_ms[1])}"


def _vocabulary(run: Run) -> str:
    return "without a vocabulary" if run.vocabulary is None else f"with the vocabulary {run.vocabulary[:12]}…"


@dataclass(frozen=True)
class Turn:
    start_ms: float
    end_ms: float
    speaker: int


@dataclass(frozen=True)
class Timeline:
    """The recording's diarized speakers. On a microphone and a system track, the microphone's speech is speaker 0
    and the system track's speakers follow."""

    tracks: tuple[str, ...]
    turns: tuple[Turn, ...]

    def track_of(self, speaker: int) -> str:
        return self.tracks[0] if len(self.tracks) == 1 or speaker == 0 else self.tracks[1]


def clock(ms: float) -> str:
    seconds = int(ms // 1000)
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"


def _read(path: Path) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if data.get("format", FORMAT) != FORMAT:
        raise ValueError(f"{path} has format {data['format']}; this scoring reads format {FORMAT}")
    return data


def _pair(value: list[float] | None) -> tuple[float, float] | None:
    return None if value is None else (value[0], value[1])


def _row(data: dict, track: str | None) -> Row:
    speakers = data.get("speakers")
    return Row(track=data.get("track", track), start_ms=data["start_ms"], end_ms=data["end_ms"], text=data["text"],
               speakers=None if speakers is None else tuple(speakers))


def _piece(data: dict) -> Piece:
    return Piece(track=data["track"], start_ms=data["start_ms"], end_ms=data["end_ms"], skipped=data["skipped"],
                 dropped=data["dropped"], wall_ms=data["wall_ms"],
                 rows=tuple(_row(row, data["track"]) for row in data["rows"]), decoding=data.get("decoding"))


def load_run(path: Path) -> Run:
    data = _read(path)
    return Run(setting=data["setting"], model=data["model"], language=data["language"], optimized=data["optimized"],
               span_ms=_pair(data.get("span_ms")), tracks=tuple(track["label"] for track in data["tracks"]),
               timing=data["timing"], pieces=tuple(_piece(piece) for piece in data["pieces"]),
               vocabulary=data["vocabulary_sha256"],
               audio=tuple(Audio(track["label"], track["audio"]["file"], track["audio"]["bytes"],
                                 track["audio"]["sha256"]) for track in data["tracks"]))


def load_reference(path: Path) -> Reference:
    """A model reference's stored rows and its run, or a human transcript's rows."""
    data = _read(path)
    if "pieces" in data:
        run = load_run(path)
        return Reference(run.rows(), run)
    return Reference([_row(row, None) for row in data["rows"]])


def load_diarization(path: Path) -> Timeline:
    data = _read(path)
    return Timeline(tracks=tuple(data["tracks"]),
                    turns=tuple(Turn(t["start_ms"], t["end_ms"], t["speaker"]) for t in data["segments"]))


def row_word_times(row: Row) -> list[float]:
    """A time for each of the row's normalised words: spread evenly over the row, so it is only as precise as the
    rows are short."""
    count = len(words(row.text))
    step = (row.end_ms - row.start_ms) / max(count, 1)
    return [row.start_ms + (i + 0.5) * step for i in range(count)]


def clip(rows: list[Row], span_ms: tuple[float, float] | None) -> list[Row]:
    """The words of the rows that lie inside the span by their word time. A row that reaches past an edge keeps
    the normalised words inside, over their share of its time, so that each keeps its word time. Both a run and its
    reference are clipped: a run's pieces reach into the span whole, and a reference's rows may cross it."""
    if span_ms is None:
        return list(rows)
    clipped = []
    for row in rows:
        times = row_word_times(row)
        inside = [i for i, ms in enumerate(times) if span_ms[0] <= ms < span_ms[1]]
        if len(inside) == len(times) and (times or span_ms[0] <= row.start_ms < span_ms[1]):
            clipped.append(row)
        elif inside:
            first, last = inside[0], inside[-1]
            step = (row.end_ms - row.start_ms) / len(times)
            clipped.append(Row(row.track, row.start_ms + first * step, row.start_ms + (last + 1) * step,
                               " ".join(words(row.text)[first:last + 1]), row.speakers))
    return clipped


def by_track(rows: list[Row], tracks: tuple[str, ...]) -> dict[str, list[Row]]:
    """Rows per track in time order. A row without a track belongs to the only track; a row on another track is
    refused (a reference made from another source than the run)."""
    grouped: dict[str, list[Row]] = {track: [] for track in tracks}
    for row in rows:
        track = row.track
        if track is None:
            if len(tracks) != 1:
                raise ValueError(f"a reference row has no track, and the run has {len(tracks)} tracks")
            track = tracks[0]
        if track not in grouped:
            raise ValueError(f"a row is on the track {track!r}; the run has {', '.join(map(repr, tracks))}")
        grouped[track].append(row)
    for track_rows in grouped.values():
        track_rows.sort(key=lambda row: row.start_ms)
    return grouped
