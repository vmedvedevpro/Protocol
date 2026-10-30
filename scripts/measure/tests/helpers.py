"""Small runs and rows for the tests."""

from kit.runs import Piece, Row, Run


def row(start_ms: float, end_ms: float, text: str, track: str | None = None, speakers=None) -> Row:
    return Row(track, start_ms, end_ms, text, None if speakers is None else tuple(speakers))


def piece(track: str, start_ms: float, end_ms: float, *rows: tuple, skipped=None, dropped=False) -> Piece:
    """`rows` as (start, end, text[, speakers])."""
    return Piece(track, start_ms, end_ms, skipped, dropped, 100.0,
                 tuple(row(r[0], r[1], r[2], track, r[3] if len(r) > 3 else None) for r in rows))


def run(*pieces: Piece, tracks=("mixed audio",), span_ms=None, language="ru", vocabulary=None) -> Run:
    timing = {"warmup_ms": 0.0, "vad_ms": 0.0, "detection_ms": 0.0, "transcription_ms": 1000.0, "speech_ms": 9000.0}
    return Run("post-meeting", "model.bin", language, True, span_ms, tuple(tracks), timing, tuple(pieces),
               vocabulary=vocabulary)
