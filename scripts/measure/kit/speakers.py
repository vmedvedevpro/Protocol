"""How well a run's rows carry the diarized speakers.

Diarization labels each row by the speakers it overlaps on the recording's timeline (`diarize_meeting`; the run
stores those labels). A row that spans a change of speaker gives part of its time to the wrong person, and longer
rows do so more often. On a microphone and a system track the timeline holds both, so a system row the user talks
over can get the user as its main speaker. The timeline is the reference here: these numbers say what the rows cost
the labelling, not whether the diarization is right.
"""

import math
from dataclasses import dataclass

from .runs import Row, Run, Timeline

SLICE_MS = 100
# Another speaker inside a row for at least this long is a change of speaker; less is within the timeline's own
# boundary jitter (about two words).
TURN_MS = 500


@dataclass
class SpeakerScore:
    # The rows whose middle lies in the span.
    rows: int
    mean_row_s: float
    # The share of the timeline's single-speaker speech, in 100 ms slices, that lies inside a row of the speaker's
    # track.
    covered: float
    # The share of those covered slices whose row's main speaker is the slice's speaker.
    agreement: float
    # Rows in which another speaker of the row's track talks for TURN_MS or more.
    turn_rows: int
    # Rows the app labels with two or more speakers ("Speaker 1 + Speaker 2").
    shared_rows: int


def _slices(start_ms: float, end_ms: float, from_ms: float, to_ms: float) -> range:
    """The indices of the slices from `from_ms` whose middle lies in [start_ms, end_ms)."""
    first = max(0, math.ceil((start_ms - from_ms - SLICE_MS / 2) / SLICE_MS))
    last = math.ceil((min(end_ms, to_ms) - from_ms - SLICE_MS / 2) / SLICE_MS)
    return range(first, max(first, last))


def single_speaker_slices(timeline: Timeline, span_ms: tuple[float, float]) -> list[tuple[float, int]]:
    """The middle of each 100 ms slice of the span in which exactly one speaker talks, with that speaker."""
    begin, end = span_ms
    active: list[set[int]] = [set() for _ in _slices(begin, end, begin, end)]
    for turn in timeline.turns:
        for index in _slices(turn.start_ms, turn.end_ms, begin, end):
            active[index].add(turn.speaker)
    return [(begin + index * SLICE_MS + SLICE_MS / 2, next(iter(speakers)))
            for index, speakers in enumerate(active) if len(speakers) == 1]


def overlap_by_speaker(timeline: Timeline, start_ms: float, end_ms: float) -> dict[int, float]:
    overlap: dict[int, float] = {}
    for turn in timeline.turns:
        ms = min(turn.end_ms, end_ms) - max(turn.start_ms, start_ms)
        if ms > 0:
            overlap[turn.speaker] = overlap.get(turn.speaker, 0.0) + ms
    return overlap


def has_turn_change(row: Row, timeline: Timeline) -> bool:
    """Whether another speaker of the row's track talks inside it for TURN_MS: the row spans a change of speaker.
    A remote speaker over a microphone row is crosstalk, not a turn the row could have ended at."""
    if not row.speakers:
        return False
    main = row.speakers[0]
    return any(speaker != main and ms >= TURN_MS and timeline.track_of(speaker) == row.track
               for speaker, ms in overlap_by_speaker(timeline, row.start_ms, row.end_ms).items())


def score(run: Run, timeline: Timeline) -> SpeakerScore | None:
    """Over the run's span, or the whole timeline; None when the timeline has no single-speaker speech there."""
    if set(timeline.tracks) != set(run.tracks):
        raise ValueError(f"the timeline is of {', '.join(timeline.tracks)}; the {run.setting} run has "
                         f"{', '.join(run.tracks)}")
    span = run.span_ms or (0.0, max((turn.end_ms for turn in timeline.turns), default=0.0))
    rows = sorted((row for row in run.rows() if row.end_ms > row.start_ms
                   and span[0] <= (row.start_ms + row.end_ms) / 2 < span[1]), key=lambda row: row.start_ms)
    # The first row of each track over each slice of the span.
    row_at: dict[str, dict[int, Row]] = {track: {} for track in run.tracks}
    for row in rows:
        for index in _slices(row.start_ms, row.end_ms, span[0], span[1]):
            row_at[row.track].setdefault(index, row)
    covered = agreed = speech = 0
    for middle, speaker in single_speaker_slices(timeline, span):
        speech += 1
        row = row_at.get(timeline.track_of(speaker), {}).get(int((middle - span[0]) // SLICE_MS))
        if row is not None:
            covered += 1
            agreed += bool(row.speakers) and row.speakers[0] == speaker
    if not speech:
        return None
    return SpeakerScore(
        rows=len(rows),
        mean_row_s=sum(row.end_ms - row.start_ms for row in rows) / len(rows) / 1000 if rows else 0.0,
        covered=covered / speech,
        agreement=agreed / covered if covered else 0.0,
        turn_rows=sum(has_turn_change(row, timeline) for row in rows),
        shared_rows=sum(len(row.speakers or ()) > 1 for row in rows),
    )
