"""How well a run's rows carry the diarized speakers.

Diarization labels each row by the speakers it overlaps (`diarize_meeting`; the run stores those labels). A row
that spans a change of speaker gives part of its time to the wrong person, and longer rows do so more often. The
timeline is the reference here: these numbers say what the rows cost the labelling, not whether the diarization is
right.
"""

from dataclasses import dataclass

from .runs import Row, Run, Timeline

SLICE_MS = 100
# Another speaker inside a row for at least this long is a change of speaker; less is within the timeline's own
# boundary jitter (about two words).
TURN_MS = 500


@dataclass
class SpeakerScore:
    rows: int
    mean_row_s: float
    # The share of the timeline's single-speaker speech, in 100 ms slices, that lies inside a row.
    covered: float
    # The share of those covered slices whose row's main speaker is the slice's speaker.
    agreement: float
    # Rows in which a speaker other than the row's main one talks for TURN_MS or more.
    turn_rows: int
    # Rows the app labels with two or more speakers ("Speaker 1 + Speaker 2").
    shared_rows: int


def single_speaker_slices(timeline: Timeline) -> list[tuple[float, int]]:
    """The middle of each 100 ms slice in which exactly one speaker talks, with that speaker."""
    slices = []
    start = timeline.start_ms
    while start < timeline.end_ms:
        middle = start + SLICE_MS / 2
        active = {turn.speaker for turn in timeline.turns if turn.start_ms <= middle < turn.end_ms}
        if len(active) == 1:
            slices.append((middle, active.pop()))
        start += SLICE_MS
    return slices


def overlap_by_speaker(timeline: Timeline, start_ms: float, end_ms: float) -> dict[int, float]:
    overlap: dict[int, float] = {}
    for turn in timeline.turns:
        ms = min(turn.end_ms, end_ms) - max(turn.start_ms, start_ms)
        if ms > 0:
            overlap[turn.speaker] = overlap.get(turn.speaker, 0.0) + ms
    return overlap


def has_turn_change(row: Row, timeline: Timeline) -> bool:
    if not row.speakers:
        return False
    main = row.speakers[0]
    return any(speaker != main and ms >= TURN_MS
               for speaker, ms in overlap_by_speaker(timeline, row.start_ms, row.end_ms).items())


def score(run: Run, timelines: dict[str, Timeline]) -> SpeakerScore | None:
    """Over the diarized tracks, for the rows inside each timeline's span; None when no track was diarized."""
    rows: list[Row] = []
    covered = agreed = speech = 0
    for track, timeline in timelines.items():
        track_rows = sorted((row for row in run.rows() if row.track == track and row.end_ms > row.start_ms
                             and timeline.start_ms <= row.start_ms < timeline.end_ms), key=lambda row: row.start_ms)
        rows += track_rows
        for middle, speaker in single_speaker_slices(timeline):
            speech += 1
            row = next((r for r in track_rows if r.start_ms <= middle < r.end_ms), None)
            if row is not None:
                covered += 1
                agreed += bool(row.speakers) and row.speakers[0] == speaker
    if not speech:
        return None
    turn_rows = sum(has_turn_change(row, timelines[row.track]) for row in rows)
    return SpeakerScore(
        rows=len(rows),
        mean_row_s=sum(row.end_ms - row.start_ms for row in rows) / len(rows) / 1000 if rows else 0.0,
        covered=covered / speech,
        agreement=agreed / covered if covered else 0.0,
        turn_rows=turn_rows,
        shared_rows=sum(len(row.speakers or ()) > 1 for row in rows),
    )
