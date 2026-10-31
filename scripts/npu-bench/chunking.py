"""Static-shape chunking of Parakeet's input (#80): which audio each encoder call sees and which of its words it
keeps, when every call is one fixed window (the NPU's 608 frames, 6.07 s).

#66 found that zero-padding the features to 608 frames costs about 2 points of WER, and only in the long pieces:
the VAD caps continuous speech at 6 s, the cap cuts the last word, and with the padding the encoder sees speech that
stops dead against zeros and more often drops that word. A 6 s piece fills the window, so there is no room for
context after it. The variants here therefore stop decoding where the VAD's cap would, but give the encoder real
audio past it, within the same window:

- `pieces`: the kit's pieces as they are, one call each, padded (the baseline);
- `span`: within each stretch of continuous speech (the kit's pieces that touch, the cap's cuts), spans of
  `span_s` seconds, each decoded in a window that starts with it and runs on into the next span's audio (right
  context of `window_s - span_s`); a call keeps the words that start inside its span;
- `overlap`: windows every `hop_s` seconds over the stretch, the last one aligned to its end, so that two
  neighbours overlap by `window_s - hop_s` and each word near a junction is heard whole, with context on both
  sides, by both calls. The junction is placed on an anchor (`merge`): a word both calls decoded the same, at
  most `ANCHOR_MS` apart in time, the one nearest the middle of the overlap; the earlier call's words run up to
  and including it, the later call's after it. Without an anchor, or with `merge="midpoint"`, each call keeps the
  words that start on its side of the middle.

Words are the decoder's tokens grouped from one that begins with a space (SentencePiece's word start) to the next;
a word's time is its first token's frame (80 ms). Two calls time the same word a frame or two apart, so a word
starting near the middle of the overlap can fall on the earlier call's side in one and on the later call's side in
the other: the midpoint rule then keeps it twice or loses it, which the anchor avoids. In `span` a call starts at
its span with no left context, so it can also decode the tail of a word cut by the previous span as a new word.
Stretches no longer than one window are a single call, as in `pieces`.
"""

import re
from dataclasses import dataclass

TOUCH_MS = 50.0  # pieces this close are one stretch: the VAD's cap cuts without a gap (0-30 ms in the fixture)
# Two calls agree on a word's time within a few 80 ms encoder frames; farther apart, an equal word is another
# occurrence (a repeated word in the sentence).
ANCHOR_MS = 320.0
_NOT_WORD = re.compile(r"[\W_]+")


@dataclass
class Window:
    start_ms: float   # the audio the call sees
    end_ms: float
    keep_from_ms: float  # `span` and `midpoint`: the words it keeps start in [keep_from_ms, keep_to_ms)
    keep_to_ms: float
    stretch: int = 0
    first: bool = True   # the stretch's first call: nothing to merge with before it


def stretches(pieces: list[dict]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for piece in pieces:
        if out and piece["start_ms"] - out[-1][1] <= TOUCH_MS:
            out[-1][1] = piece["end_ms"]
        else:
            out.append([piece["start_ms"], piece["end_ms"]])
    return [(a, b) for a, b in out]


def quietest(energy, at_ms: float, lo_ms: float, hi_ms: float) -> float:
    """The start of the quietest 20 ms frame in [lo_ms, hi_ms] (`energy(ms)` is a frame's RMS), or `at_ms`."""
    best = None
    t = lo_ms
    while t <= hi_ms:
        e = energy(t)
        if best is None or e < best[0]:
            best = (e, t)
        t += 20.0
    return best[1] if best else at_ms


def plan(pieces: list[dict], mode: str, window_s: float, span_s: float = 5.0, hop_s: float = 4.0,
         energy=None, snap_s: float = 0.0) -> list[Window]:
    """With `energy` and `snap_s`, an `overlap` window after the first starts at the quietest 20 ms within
    `snap_s` of its place (a pause between words rather than the middle of one). The last window ends at the
    stretch's end, so it may only start later and be shorter: its features are padded after the end of the
    speech, where the VAD found a pause, not after a cut."""
    if mode == "pieces":
        return [Window(p["start_ms"], p["end_ms"], p["start_ms"], p["end_ms"], i) for i, p in enumerate(pieces)]
    window = window_s * 1000.0
    windows: list[Window] = []
    for index, (start, end) in enumerate(stretches(pieces)):
        if end - start <= window:
            windows.append(Window(start, end, start, end, index))
            continue
        if mode == "span":
            span = span_s * 1000.0
            at = start
            while at < end:
                windows.append(Window(at, min(at + window, end), at, min(at + span, end), index, at == start))
                at += span
        elif mode == "overlap":
            hop = hop_s * 1000.0
            snap = snap_s * 1000.0
            starts = []
            at = start
            while at + window < end:
                if starts and energy is not None and snap:
                    at = quietest(energy, at, max(at - snap, starts[-1] + 1000.0), at + snap)
                starts.append(at)
                at += hop
            last = end - window
            if energy is not None and snap:
                last = quietest(energy, last, last, min(last + snap, end - 2000.0))
            if last > starts[-1]:
                starts.append(last)
            ends = [min(s + window, end) for s in starts]
            for i, s in enumerate(starts):
                lo = start if i == 0 else (s + ends[i - 1]) / 2.0
                hi = end if i == len(starts) - 1 else (starts[i + 1] + ends[i]) / 2.0
                windows.append(Window(s, ends[i], lo, hi, index, i == 0))
        else:
            raise ValueError(mode)
    return windows


def words(vocab: list[str], tokens: list[int], frames: list[int], offset_ms: float, frame_ms: float) -> list[tuple[float, str]]:
    """(start in ms, text) per word; `frames` holds each token's encoder frame."""
    out: list[list] = []
    for token, frame in zip(tokens, frames):
        piece = vocab[token]
        if not out or piece.startswith(" "):
            out.append([offset_ms + frame * frame_ms, piece])
        else:
            out[-1][1] += piece
    return [(start, text) for start, text in out]


def _same(a: str, b: str) -> bool:
    a, b = _NOT_WORD.sub("", a).lower(), _NOT_WORD.sub("", b).lower()
    return bool(a) and a == b


def merge(windows: list[Window], decoded: list[list[tuple[float, str]]], rule: str = "anchor") -> tuple[list[tuple[float, str]], dict]:
    """The words of all calls, joined at each junction of overlapping calls (see the module's notes); the
    counts of junctions joined on an anchor and at the midpoint."""
    out: list[tuple[float, str]] = []
    counts = {"anchor": 0, "midpoint": 0}
    previous: Window | None = None
    for window, current in zip(windows, decoded):
        if window.first or previous is None or rule == "keep":
            out += [w for w in current if window.keep_from_ms <= w[0] < window.keep_to_ms] if rule == "keep" else current
            previous = window
            continue
        middle = (window.start_ms + previous.end_ms) / 2.0
        best = None
        if rule == "anchor":
            for i in range(len(out) - 1, -1, -1):
                if out[i][0] < window.start_ms:
                    break
                for j, word in enumerate(current):
                    if word[0] > previous.end_ms:
                        break
                    if abs(word[0] - out[i][0]) <= ANCHOR_MS and _same(word[1], out[i][1]):
                        distance = abs((word[0] + out[i][0]) / 2.0 - middle)
                        if best is None or distance < best[0]:
                            best = (distance, i, j)
        if best is not None:
            _, i, j = best
            out = out[:i + 1] + current[j + 1:]
            counts["anchor"] += 1
        else:
            out = [w for w in out if w[0] < middle] + [w for w in current if w[0] >= middle]
            counts["midpoint"] += 1
        previous = window
    return out, counts


def assign(pieces: list[dict], kept: list[tuple[float, str]]) -> list[str]:
    """Each kept word to the piece it starts in (or the last piece that starts before it: a word timed in a gap
    between pieces), joined into the piece's text. The words keep their order."""
    texts = [""] * len(pieces)
    for start, text in kept:
        index = 0
        for i, piece in enumerate(pieces):
            if piece["start_ms"] <= start:
                index = i
        texts[index] += text
    return [" ".join(t.split()) for t in texts]
