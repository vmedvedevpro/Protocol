"""Failures a word error rate hides: pieces with almost no text, repetition loops and phrases Whisper invents."""

import re
from dataclasses import dataclass

from .runs import Piece
from .text import normalize, words

# A piece of at least 3 s that comes back with at most 2 words: the signature of an early end of text (#62).
SHORT_PIECE_MS = 3000
SHORT_OUTPUT_WORDS = 2

# Text Whisper writes over silence, noise or music, learnt from subtitles (the Russian ones are those #62 saw).
# Matched on normalised text from the start of a word, so "субтитр" also finds "субтитров".
HALLUCINATIONS = {
    "продолжение следует": r"продолжение следует",
    "субтитры": r"субтитр",
    "корректор": r"корректор",
    "subtitle credit names": r"dimatorzok|синецкая|семкин",
    "спасибо за просмотр": r"спасибо за просмотр",
    "подписывайтесь / ставьте лайк": r"подписывайтесь|ставьте лайк",
    "thanks for watching": r"thank you for watching|thanks for watching",
    "like and subscribe": r"like and subscribe",
}
_PATTERNS = {name: re.compile(rf"(?<!\w)(?:{pattern})") for name, pattern in HALLUCINATIONS.items()}
# Whisper's commonest English output over silence; as a row's whole text it is almost never speech. The
# retranscription loop drops it (and "thank you", "bye") only on quiet pieces.
LONE_WORD = "you"


def is_short_output(piece: Piece) -> bool:
    return piece.end_ms - piece.start_ms >= SHORT_PIECE_MS and len(words(piece.text)) <= SHORT_OUTPUT_WORDS


def loop_phrase(tokens: list[str]) -> str | None:
    """A phrase of 1–4 words repeated back to back: one word 4 times, a longer phrase 3 times.

    People repeat a word twice ("да да") or a pair once; a decoder stuck in a loop goes on.
    """
    for n in range(1, 5):
        times = 4 if n == 1 else 3
        for i in range(len(tokens) - n * times + 1):
            phrase = tokens[i:i + n]
            if all(tokens[i + k * n:i + (k + 1) * n] == phrase for k in range(1, times)):
                return " ".join(phrase)
    return None


def hallucinations(text: str) -> list[str]:
    """The known phrases in a row's text, by name."""
    normalised = normalize(text)
    found = [name for name, pattern in _PATTERNS.items() if pattern.search(normalised)]
    if normalised == LONE_WORD:
        found.append(f"a lone “{LONE_WORD}”")
    return found


def repeated_words(tokens: list[str]) -> int:
    """Words that repeat what was just said: every copy after the first of a 3–25-word phrase said twice in a row,
    of a 2-word phrase said three times, or of a word said four times.

    Long-form Whisper decoding writes such repeats in zero-length segments (47 % of a long-form reference's words in
    #62); natural speech rarely repeats three words back to back. Used to check a reference.
    """
    flagged = 0
    i = 0
    while i < len(tokens):
        for n in range(25, 0, -1):
            phrase = tokens[i:i + n]
            if len(phrase) < n:
                continue
            copies = 1
            while tokens[i + copies * n:i + (copies + 1) * n] == phrase:
                copies += 1
            if copies >= (2 if n >= 3 else 3 if n == 2 else 4):
                flagged += (copies - 1) * n
                i += copies * n
                break
        else:
            i += 1
    return flagged


@dataclass
class Failures:
    pieces: int
    short_outputs: int
    loops: int
    dropped: int
    # Rows with a known hallucination, and how many rows each phrase was found in.
    hallucinated_rows: int
    hallucinations: dict[str, int]


def count(pieces: tuple[Piece, ...]) -> Failures:
    """Over the transcribed pieces; hallucinations only in the rows the pass keeps."""
    transcribed = [piece for piece in pieces if piece.transcribed]
    rows = 0
    found: dict[str, int] = {}
    for row in (row for piece in transcribed if piece.kept for row in piece.rows):
        names = hallucinations(row.text)
        rows += bool(names)
        for name in names:
            found[name] = found.get(name, 0) + 1
    return Failures(
        pieces=len(transcribed),
        short_outputs=sum(is_short_output(piece) for piece in transcribed),
        loops=sum(loop_phrase(words(piece.text)) is not None for piece in transcribed),
        dropped=sum(piece.dropped for piece in transcribed),
        hallucinated_rows=rows,
        hallucinations=found,
    )
