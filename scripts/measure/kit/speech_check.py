"""The sample of the Speech check (#233): two short clips, Russian and English, each with two voices taking turns.

Built from FLEURS (Conneau et al., 2022; https://huggingface.co/datasets/google/fleurs), Google, CC BY 4.0: the same
dev split, commit and pinned downloads as the measuring kit's fixtures (`fixture.py`). FLEURS names a reader's
gender, not the reader, so two readings never certainly share a voice. Each clip therefore takes one woman's and one
man's reading and cuts each at its longest pause inside the middle half, which falls on the sentence's only comma:
voice A's first half, voice B's first half, A's second half, B's second half. The words up to the comma are the
first turn's text. Each half is levelled and cut to its speech as the fixtures' sentences are.

The assembled 16-bit PCM is checked against a pinned SHA-256, so every build gives the same samples. The clips are
written as FLAC (lossless, about half the size of WAV), which the app decodes with symphonia; FLAC's bytes depend on
the encoder's version, so the PCM is what is pinned. ffmpeg encodes the FLAC.
"""

import hashlib
import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import fixture

# Between turns: longer than the live VAD's 800 ms redemption with room for its frames, so each turn is a live piece
# of its own (the check is about devices and errors; a piece joining two recordings is #239's business), and under
# the batch VAD's 2 s redemption, so a clip is one post-meeting piece (under its 25 s cut).
GAP_S = 1.2
# The pause a reading is cut at lies in its middle half, where both halves keep several words.
MIDDLE = (0.25, 0.75)


@dataclass(frozen=True)
class Reading:
    file: str
    # The pause's middle, as a 10 ms frame of the levelled, trimmed reading; pinned so a change in the cut shows.
    split_frame: int


@dataclass(frozen=True)
class Clip:
    id: str
    language: str
    # Voice A (a woman) and voice B (a man).
    readings: tuple[Reading, Reading]
    # Of the assembled 16-bit PCM samples.
    pcm_sha256: str


CLIPS = (
    Clip("ru", "ru", (Reading("12682213204980623644.wav", 677), Reading("15069537867704390147.wav", 435)),
         "597c3adc29958c8b588abe3799ade5b4bf9139ae21b341979e820bb413a340a9"),
    Clip("en", "en", (Reading("9957590450625488532.wav", 351), Reading("10796058897134434902.wav", 813)),
         "6eaa61aa29af86acf5557a66507cc53e6c341c2711525e7a69a2b4e6b25dc867"),
)


def frame_rms(clip: list[float]) -> list[float]:
    frame = fixture.FRAME
    return [math.sqrt(sum(x * x for x in clip[s:s + frame]) / len(clip[s:s + frame])) for s in range(0, len(clip), frame)]


def split_frame(clip: list[float]) -> int:
    """The middle of the longest run of quiet frames (RMS under the fixtures' speech level) inside the middle half."""
    quiet = [rms < fixture.SPEECH_RMS for rms in frame_rms(clip)]
    frames = len(quiet)
    runs, start = [], None
    for index, is_quiet in enumerate(quiet + [False]):
        if is_quiet and start is None:
            start = index
        elif not is_quiet and start is not None:
            if start > frames * MIDDLE[0] and index < frames * MIDDLE[1]:
                runs.append((index - start, start, index))
            start = None
    if not runs:
        raise ValueError("no pause in the middle half of the reading")
    _, first, last = max(runs)
    return (first + last) // 2


def halves(text: str) -> tuple[str, str]:
    """The words up to and including the sentence's only comma, and the rest."""
    words = text.split()
    commas = [index for index, word in enumerate(words) if word.endswith(",")]
    if len(commas) != 1:
        raise ValueError(f"expected one comma in {text!r}")
    return " ".join(words[:commas[0] + 1]), " ".join(words[commas[0] + 1:])


def build(clip: Clip, cache: Path, into: Path) -> dict:
    """Writes `<into>/<id>.flac` once its PCM matches the pin; returns its entry for sample.json."""
    source = next(item for item in fixture.FIXTURES if item.language == clip.language)
    by_file = {u.file: u for u in fixture.read_transcripts(fixture.fetch(source.transcripts, cache))}
    utterances = [by_file[reading.file] for reading in clip.readings]
    if [u.gender for u in utterances] != ["FEMALE", "MALE"]:
        raise ValueError(f"{clip.id}: voice A must be a woman's reading and voice B a man's")
    audio = fixture.read_audio(fixture.fetch(source.audio, cache), {u.file for u in utterances})

    parts: list[tuple[str, str, list[float]]] = []  # (voice, text, samples) per reading half
    for voice, reading, utterance in zip("ab", clip.readings, utterances):
        whole = fixture.trimmed(fixture.leveled(audio[reading.file]))
        frame = split_frame(whole)
        if frame != reading.split_frame:
            raise ValueError(f"{clip.id}: {reading.file} now splits at frame {frame}, not the pinned {reading.split_frame}")
        print(f"{clip.id}: {reading.file} splits at frame {frame}")
        cut = frame * fixture.FRAME
        first, second = halves(utterance.text)
        parts.append((voice, first, fixture.trimmed(whole[:cut])))
        parts.append((voice, second, fixture.trimmed(whole[cut:])))
    # A1 B1 A2 B2.
    order = [parts[0], parts[2], parts[1], parts[3]]

    samples: list[float] = []
    turns = []
    gap = [0.0] * round(GAP_S * fixture.SAMPLE_RATE)
    for index, (voice, text, part) in enumerate(order):
        if index:
            samples.extend(gap)
        start = len(samples)
        samples.extend(part)
        turns.append({"start_ms": round(start * 1000 / fixture.SAMPLE_RATE),
                      "end_ms": round(len(samples) * 1000 / fixture.SAMPLE_RATE), "voice": voice, "text": text})
    pcm = fixture.pcm16(samples)
    digest = hashlib.sha256(pcm).hexdigest()
    if digest != clip.pcm_sha256:
        raise ValueError(f"{clip.id} came out with PCM SHA-256 {digest}, not the pinned {clip.pcm_sha256}")

    into.mkdir(parents=True, exist_ok=True)
    out = into / f"{clip.id}.flac"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(fixture.SAMPLE_RATE),
                    "-ac", "1", "-i", "pipe:0", "-c:a", "flac", "-compression_level", "12", str(out)],
                   input=pcm, check=True)
    print(f"{out}: {len(samples) / fixture.SAMPLE_RATE:.1f} s, {out.stat().st_size:,} bytes, PCM SHA-256 {digest}")
    return {"id": clip.id, "language": clip.language, "file": out.name, "pcm_sha256": digest, "duration_ms": round(len(samples) * 1000 / fixture.SAMPLE_RATE), "turns": turns,
            "fleurs_files": [reading.file for reading in clip.readings]}


def build_all(cache: Path, into: Path) -> Path:
    entries = [build(clip, cache, into) for clip in CLIPS]
    manifest = {"source": f"FLEURS dev (ru_ru, en_us), commit {fixture.COMMIT}",
                "license": "CC BY 4.0",
                "attribution": "FLEURS (Conneau et al., 2022), Google; https://huggingface.co/datasets/google/fleurs",
                "clips": entries}
    path = into / "sample.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {path}")
    return path
