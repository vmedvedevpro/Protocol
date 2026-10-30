"""Word and character error rates against a reference, and where the words that went missing were.

Each track is aligned on its own (its rows in time order, joined) and the counts are pooled over the tracks, so a
rate is all edits over all reference words. The alignment is jiwer's minimum edit distance: substitutions (S),
deletions (D, reference words missing from the output) and insertions (I).
"""

from dataclasses import dataclass, field

import jiwer

from .runs import Piece, Reference, Row, Run, by_track, clip, row_word_times
from .text import normalize

# Within this distance of a piece's start or end a missing word counts as lost at the edge: cuts inside speech
# lose words there (the 6 s cap of #62 lost most of its words at its cuts).
EDGE_MS = 2000
# From this many consecutive missing reference words on, a stretch of speech is lost (a phrase, not a misheard word).
LOST_STRETCH_WORDS = 5


@dataclass(frozen=True)
class Errors:
    """Edit counts against a reference of `reference` units (words, or characters including spaces)."""

    reference: int
    substitutions: int = 0
    deletions: int = 0
    insertions: int = 0

    @property
    def rate(self) -> float | None:
        if not self.reference:
            return None
        return (self.substitutions + self.deletions + self.insertions) / self.reference

    def __add__(self, other: "Errors") -> "Errors":
        return Errors(self.reference + other.reference, self.substitutions + other.substitutions,
                      self.deletions + other.deletions, self.insertions + other.insertions)


def word_errors(reference: list[str], hypothesis: list[str]) -> tuple[Errors, list[tuple[int, int]]]:
    """The edits, and the deleted reference words as [start, end) index ranges, one per consecutive run."""
    if not reference:
        return Errors(0, insertions=len(hypothesis)), []
    if not hypothesis:
        return Errors(len(reference), deletions=len(reference)), [(0, len(reference))]
    out = jiwer.process_words(" ".join(reference), " ".join(hypothesis))
    deleted = [(chunk.ref_start_idx, chunk.ref_end_idx) for chunk in out.alignments[0] if chunk.type == "delete"]
    return Errors(len(reference), out.substitutions, out.deletions, out.insertions), deleted


def char_errors(reference: str, hypothesis: str) -> Errors:
    if not reference:
        return Errors(0, insertions=len(hypothesis))
    if not hypothesis:
        return Errors(len(reference), deletions=len(reference))
    out = jiwer.process_characters(reference, hypothesis)
    return Errors(len(reference), out.substitutions, out.deletions, out.insertions)


def word_times(rows: list[Row]) -> list[float]:
    """A time for each reference word (`row_word_times`)."""
    return [ms for row in rows for ms in row_word_times(row)]


@dataclass
class LostStretch:
    track: str
    start_ms: float
    words: int


@dataclass
class Deletions:
    """Where the missing reference words were, against the pieces the pass transcribed and kept."""

    outside_pieces: int = 0
    at_piece_edges: int = 0
    inside_pieces: int = 0
    lost_stretches: list[LostStretch] = field(default_factory=list)

    def add(self, other: "Deletions") -> None:
        self.outside_pieces += other.outside_pieces
        self.at_piece_edges += other.at_piece_edges
        self.inside_pieces += other.inside_pieces
        self.lost_stretches += other.lost_stretches


def place_deletions(track: str, deleted: list[tuple[int, int]], times: list[float], pieces: list[Piece]) -> Deletions:
    """Outside every kept piece means the VAD missed the speech, or the pass skipped or dropped its piece."""
    placed = Deletions()
    for start, end in deleted:
        if end - start >= LOST_STRETCH_WORDS:
            placed.lost_stretches.append(LostStretch(track, times[start], end - start))
        for ms in times[start:end]:
            piece = next((p for p in pieces if p.start_ms <= ms <= p.end_ms), None)
            if piece is None:
                placed.outside_pieces += 1
            elif ms - piece.start_ms <= EDGE_MS or piece.end_ms - ms <= EDGE_MS:
                placed.at_piece_edges += 1
            else:
                placed.inside_pieces += 1
    return placed


@dataclass
class Accuracy:
    words: Errors
    characters: Errors
    tracks: dict[str, Errors]
    deletions: Deletions


def score(run: Run, reference: Reference) -> Accuracy:
    """The run against the reference, track by track, both clipped to the run's span by word time."""
    reference.check(run)
    expected = by_track(clip(reference.rows, run.span_ms), run.tracks)
    produced = by_track(clip(run.rows(), run.span_ms), run.tracks)
    total_words, total_chars = Errors(0), Errors(0)
    tracks: dict[str, Errors] = {}
    deletions = Deletions()
    for track in run.tracks:
        reference_text = normalize(" ".join(row.text for row in expected[track]))
        output_text = normalize(" ".join(row.text for row in produced[track]))
        errors, deleted = word_errors(reference_text.split(), output_text.split())
        tracks[track] = errors
        total_words += errors
        total_chars += char_errors(reference_text, output_text)
        kept = [piece for piece in run.pieces if piece.track == track and piece.kept]
        deletions.add(place_deletions(track, deleted, word_times(expected[track]), kept))
    deletions.lost_stretches.sort(key=lambda stretch: -stretch.words)
    return Accuracy(total_words, total_chars, tracks, deletions)
