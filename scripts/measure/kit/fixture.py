"""The public fixtures: two-voice recordings assembled from FLEURS read speech, with FLEURS's human transcripts.

FLEURS (Conneau et al., 2022, "FLEURS: Few-shot Learning Evaluation of Universal Representations of Speech";
https://huggingface.co/datasets/google/fleurs) is published by Google under CC BY 4.0. Its readers read Wikipedia
sentences; FLEURS does not say which reader read what, only the reader's gender.

A fixture alternates women's and men's readings, so neighbouring sentences come from different voices. Every
sentence is scaled to the same peak and cut to its speech. They are laid out in groups of three: inside a group the
gaps are shorter than the batch VAD's 2 s redemption time, so a group is one piece of about 30 s with changes of voice
inside it, which the post-meeting pass cuts at 25 s; between groups the gaps are longer, so pieces end there. The
reference is FLEURS's transcripts with the times of the layout.

The downloads are pinned to one commit of the dataset with their sizes and SHA-256 and kept in a cache; the
assembled audio is checked against its own SHA-256, so every machine measures the same file. Nothing here is
committed: the cache and the fixtures live in the git-ignored `.measure/` folder.
"""

import array
import csv
import hashlib
import io
import json
import math
import struct
import tarfile
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path

from .runs import FORMAT

COMMIT = "70bb2e84b976b7e960aa89f1c648e09c59f894dd"
BASE_URL = f"https://huggingface.co/datasets/google/fleurs/resolve/{COMMIT}/data"
SAMPLE_RATE = 16_000

UTTERANCES = 24
GROUP = 3
GAP_IN_GROUP_S = 0.6
GAP_BETWEEN_GROUPS_S = 3.0
# FLEURS recorded its readers at very different gains: half of the English sentences peak below 0.021 and some at
# 0.004, under the post-meeting pass's silence rule (peak < 0.01) and far below a meeting's levels. Each sentence is
# scaled to this peak (-6 dBFS), so the fixture measures transcription, not a reader's microphone gain.
PEAK = 0.5
# FLEURS clips carry their own silence at both ends, often more than a second, which with the gap would outlast the
# VAD's redemption time and end a piece after most sentences. Each levelled clip is cut to its speech: from the first
# to the last 10 ms frame with an RMS of at least SPEECH_RMS (34 dB under the peak), with MARGIN_S around them.
FRAME = SAMPLE_RATE // 100
SPEECH_RMS = PEAK / 50
MARGIN_S = 0.1
# A stalled download fails after this long without data.
DOWNLOAD_TIMEOUT_S = 60


@dataclass(frozen=True)
class Download:
    url: str
    size: int
    sha256: str

    @property
    def name(self) -> str:
        return "fleurs-" + self.url.removeprefix(BASE_URL + "/").replace("/audio/", "-").replace("/", "-")


@dataclass(frozen=True)
class Fixture:
    name: str
    language: str
    transcripts: Download
    audio: Download
    # Of the assembled audio.wav.
    sha256: str


FIXTURES = (
    Fixture(
        name="fleurs-ru",
        language="ru",
        transcripts=Download(f"{BASE_URL}/ru_ru/dev.tsv", 316_328,
                             "25d9dc88a7533fc0f303354a8e6d3c8186c557229c9a0024487090a11226171e"),
        audio=Download(f"{BASE_URL}/ru_ru/audio/dev.tar.gz", 187_377_526,
                       "4dc533cd0f312f749bd6d0fe968f3183288d938e07ed97dc141d9f10570457f9"),
        sha256="a5c4b5149403c2e97eddadaf7497f498ccd9c698ae127b47692d7268a0116f25",
    ),
    Fixture(
        name="fleurs-en",
        language="en",
        transcripts=Download(f"{BASE_URL}/en_us/dev.tsv", 213_065,
                             "9d57ee7e91e9d4c92edb39f6bbea668ef8dc2a3ff96eb510d5580b2ad05d17ec"),
        audio=Download(f"{BASE_URL}/en_us/audio/dev.tar.gz", 171_250_900,
                       "2658fda72f199e12676ecac9415094667a4e14e149b146e568ea00b2a2f0954c"),
        sha256="91eb68fd3c1b4fb8a70fba8010784ac0a1a875588dbfd18f60ee1f5198a820fd",
    ),
)


@dataclass(frozen=True)
class Utterance:
    sentence: str
    file: str
    text: str
    gender: str


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        while chunk := file.read(1 << 20):
            digest.update(chunk)
    return digest.hexdigest()


def fetch(download: Download, cache: Path) -> Path:
    """The cached file, downloaded first if it is missing; refused unless its size and SHA-256 match."""
    path = cache / download.name
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        partial = path.with_suffix(path.suffix + ".part")
        print(f"downloading {download.url} ({download.size / 1e6:.0f} MB)")
        with urllib.request.urlopen(download.url, timeout=DOWNLOAD_TIMEOUT_S) as response, partial.open("wb") as file:
            while chunk := response.read(1 << 20):
                file.write(chunk)
        partial.replace(path)
    if path.stat().st_size != download.size or sha256(path) != download.sha256:
        raise ValueError(f"{path} does not match its pinned size and SHA-256; delete it to download it again")
    return path


def read_transcripts(path: Path) -> list[Utterance]:
    """FLEURS's TSV: id, file name, raw transcription, normalised transcription, characters, samples, gender."""
    with path.open(encoding="utf-8", newline="") as file:
        return [Utterance(sentence=row[0], file=row[1], text=row[2], gender=row[6])
                for row in csv.reader(file, delimiter="\t", quoting=csv.QUOTE_NONE)]


def choose(utterances: list[Utterance], count: int = UTTERANCES) -> list[Utterance]:
    """`count` readings of distinct sentences, alternating a woman's and a man's voice: for each in turn, the first
    reading in the file by that voice of a sentence not chosen yet."""
    chosen: list[Utterance] = []
    used: set[str] = set()
    while len(chosen) < count:
        gender = ("FEMALE", "MALE")[len(chosen) % 2]
        utterance = next((u for u in utterances if u.gender == gender and u.sentence not in used), None)
        if utterance is None:
            raise ValueError(f"FLEURS has too few {gender.lower()} readings of distinct sentences")
        used.add(utterance.sentence)
        chosen.append(utterance)
    return chosen


def float_wav_samples(data: bytes) -> array.array:
    """The samples of a FLEURS WAV: 16 kHz mono 32-bit float (format 3, which the `wave` module cannot read)."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a WAV file")
    position, fmt, samples = 12, None, None
    while position + 8 <= len(data):
        chunk, size = data[position:position + 4], struct.unpack_from("<I", data, position + 4)[0]
        body = data[position + 8:position + 8 + size]
        if chunk == b"fmt ":
            fmt = struct.unpack_from("<HHI", body)
        elif chunk == b"data":
            samples = array.array("f", body)
        position += 8 + size + (size & 1)
    if fmt != (3, 1, SAMPLE_RATE) or samples is None:
        raise ValueError(f"expected 16 kHz mono float samples, found format {fmt}")
    return samples


def read_audio(archive: Path, files: set[str]) -> dict[str, array.array]:
    found: dict[str, array.array] = {}
    with tarfile.open(archive, "r|gz") as tar:
        for member in tar:
            name = member.name.rsplit("/", 1)[-1]
            if member.isfile() and name in files:
                found[name] = float_wav_samples(tar.extractfile(member).read())
    missing = files - found.keys()
    if missing:
        raise ValueError(f"{archive.name} lacks {sorted(missing)}")
    return found


def layout(durations_s: list[float]) -> list[float]:
    """Where each utterance starts, in seconds."""
    starts, position = [], 0.0
    for index, duration in enumerate(durations_s):
        starts.append(position)
        last_of_group = (index + 1) % GROUP == 0
        position += duration + (GAP_BETWEEN_GROUPS_S if last_of_group else GAP_IN_GROUP_S)
    return starts


def leveled(clip: array.array) -> list[float]:
    """The clip scaled to a peak of `PEAK`."""
    peak = max(map(abs, clip), default=0.0)
    return [x * PEAK / peak for x in clip] if peak else list(clip)


def trimmed(clip: list[float]) -> list[float]:
    """The clip without the silence before and after its speech; unchanged when no frame reaches SPEECH_RMS."""
    loud = [start for start in range(0, len(clip), FRAME)
            if math.sqrt(sum(x * x for x in clip[start:start + FRAME]) / len(clip[start:start + FRAME])) >= SPEECH_RMS]
    if not loud:
        return clip
    margin = round(MARGIN_S * SAMPLE_RATE)
    return clip[max(0, loud[0] - margin):min(len(clip), loud[-1] + FRAME + margin)]


def pcm16_wav(samples: list[float]) -> bytes:
    pcm = array.array("h", (round(max(-1.0, min(1.0, x)) * 32767) for x in samples))
    data = io.BytesIO()
    with wave.open(data, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm.tobytes())
    return data.getvalue()


def build(fixture: Fixture, cache: Path, into: Path) -> Path:
    """Writes `<into>/<name>/audio.wav` and `reference.json` once the audio matches its pin; returns the folder."""
    utterances = choose(read_transcripts(fetch(fixture.transcripts, cache)))
    audio = read_audio(fetch(fixture.audio, cache), {u.file for u in utterances})
    clips = [trimmed(leveled(audio[u.file])) for u in utterances]
    durations = [len(clip) / SAMPLE_RATE for clip in clips]
    starts = layout(durations)
    total = round((starts[-1] + durations[-1]) * SAMPLE_RATE)
    samples = [0.0] * total
    for clip, start in zip(clips, starts):
        offset = round(start * SAMPLE_RATE)
        samples[offset:offset + len(clip)] = clip
    wav_bytes = pcm16_wav(samples)
    digest = hashlib.sha256(wav_bytes).hexdigest()
    if digest != fixture.sha256:
        raise ValueError(f"{fixture.name} came out with SHA-256 {digest}, not the pinned {fixture.sha256}")

    folder = into / fixture.name
    folder.mkdir(parents=True, exist_ok=True)
    wav = folder / "audio.wav"
    wav.write_bytes(wav_bytes)
    rows = [{"start_ms": round(start * 1000), "end_ms": round((start + duration) * 1000), "text": u.text,
             "voice": u.gender.lower(), "fleurs_file": u.file}
            for u, start, duration in zip(utterances, starts, durations)]
    reference = {"format": FORMAT, "source": f"FLEURS dev ({fixture.language}), commit {COMMIT}, CC BY 4.0",
                 "language": fixture.language, "rows": rows}
    (folder / "reference.json").write_text(json.dumps(reference, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{folder}: {total / SAMPLE_RATE:.1f} s, {len(rows)} sentences, audio SHA-256 {digest}")
    return folder
