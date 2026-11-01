"""Accuracy fixtures for #80 round 2 beyond FLEURS's read speech, in the kit's format (`audio.wav`, 16 kHz mono
16-bit, and `reference.json` with human rows), so `measure.py score` and the kit read them like the FLEURS ones.

    python fixtures_r2.py ami --meeting ES2004a --mic Mix-Headset --into .measure/fixtures/ami-es2004a-mix
    python fixtures_r2.py ami --meeting ES2004a --mic Array1-01 --into .measure/fixtures/ami-es2004a-sdm
    python fixtures_r2.py golos --minutes 15 --into .measure/fixtures/golos-farfield

- AMI (Carletta et al., 2005; CC BY 4.0): a whole meeting from the corpus mirror at the University of Edinburgh,
  the headset mix or the first microphone of array 1 (the distant microphone, SDM). The official annotation
  archive answers 403 without its web form, so the reference rows are the manual transcripts as the
  `edinburghcstr/ami` dataset publishes them (its `ihm` test segments of the meeting: speaker, begin and end time,
  upper-case text with the fillers the annotators kept), read through the Hugging Face dataset viewer's rows API.
  Overlapping speakers' rows are ordered by start time.
- Golos farfield (SberDevices, 2021; "public license with attribution and conditions reserved", research and
  commercial use allowed): read commands to a smart speaker, recorded from its far-field microphones; the test
  split's first utterances in order up to `--minutes`, from the `bond005/sberdevices_golos_100h_farfield` mirror.
  They are laid out as the FLEURS fixtures are (`kit.fixture`: each scaled to the same peak and cut to its speech,
  groups of three with short gaps inside and long ones between), so the VAD cuts pieces of several utterances.

Downloads are cached in `.measure/cache/`; `source.json` next to the fixture records the URLs, dataset revisions and
the SHA-256 of every file. Nothing here is committed: `.measure/` is git-ignored.
"""

import argparse
import array
import hashlib
import io
import json
import sys
import time
import urllib.parse
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/measure"))
from kit import fixture  # noqa: E402
from kit.runs import FORMAT  # noqa: E402

CACHE = ROOT / ".measure/cache"
ROWS_API = "https://datasets-server.huggingface.co"
AMI_AUDIO = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/{meeting}/audio/{meeting}.{mic}.wav"
GOLOS = "bond005/sberdevices_golos_100h_farfield"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def get(url: str, tries: int = 4) -> bytes:
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return response.read()
        except OSError:
            if attempt == tries - 1:
                raise
            time.sleep(2 + 3 * attempt)
    raise AssertionError


def page(dataset: str, config: str, split: str, offset: int, length: int = 100) -> list[dict]:
    """One page of a Hugging Face dataset's rows through the dataset viewer's API (100 rows is its limit)."""
    query = {"dataset": dataset, "config": config, "split": split, "offset": offset, "length": length}
    return json.loads(get(f"{ROWS_API}/rows?{urllib.parse.urlencode(query)}")).get("rows", [])


def meeting_rows(dataset: str, config: str, split: str, meeting: str) -> list[dict]:
    """The rows of one meeting. The viewer's filter endpoint needs a Hub login, so this reads plain pages: the
    split lists the meetings in name order (EN2002a ... TS3003d), so a coarse search finds the meeting's block."""
    def first_meeting(offset: int) -> str | None:
        found = page(dataset, config, split, offset, 1)
        return found[0]["row"]["meeting_id"] if found else None

    step, offset = 500, 0
    while (found := first_meeting(offset + step)) is not None and found < meeting:
        offset += step
    out = []
    while True:
        batch = page(dataset, config, split, offset)
        if not batch:
            break
        out += [r["row"] for r in batch if r["row"]["meeting_id"] == meeting]
        if batch[-1]["row"]["meeting_id"] > meeting:
            break
        offset += len(batch)
    return out


def revision(dataset: str) -> str:
    return json.loads(get(f"https://huggingface.co/api/datasets/{dataset}"))["sha"]


def pcm16(path_or_bytes) -> tuple[array.array, int]:
    with wave.open(io.BytesIO(path_or_bytes) if isinstance(path_or_bytes, bytes) else str(path_or_bytes)) as w:
        assert w.getsampwidth() == 2 and w.getnchannels() == 1, (w.getsampwidth(), w.getnchannels())
        return array.array("h", w.readframes(w.getnframes())), w.getframerate()


def write(into: Path, wav_bytes: bytes, reference: dict, source: dict) -> None:
    into.mkdir(parents=True, exist_ok=True)
    (into / "audio.wav").write_bytes(wav_bytes)
    (into / "reference.json").write_text(json.dumps(reference, ensure_ascii=False, indent=1), encoding="utf-8")
    source["audio_sha256"] = sha256(wav_bytes)
    (into / "source.json").write_text(json.dumps(source, ensure_ascii=False, indent=1), encoding="utf-8")
    seconds = (len(wav_bytes) - 44) / 32000
    print(f"{into}: {seconds / 60:.1f} min, {len(reference['rows'])} rows, audio SHA-256 {source['audio_sha256']}")


def ami(args: argparse.Namespace) -> None:
    url = AMI_AUDIO.format(meeting=args.meeting, mic=args.mic)
    cached = CACHE / "ami" / url.rsplit("/", 1)[1]
    if not cached.exists():
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(get(url))
    data = cached.read_bytes()
    samples, rate = pcm16(data)
    assert rate == fixture.SAMPLE_RATE, rate
    segments = meeting_rows("edinburghcstr/ami", "ihm", "test", args.meeting)
    assert segments, f"no ihm test segments for {args.meeting}"
    segments.sort(key=lambda r: (r["begin_time"], r["end_time"]))
    reference = {"format": FORMAT, "language": "en",
                 "source": f"AMI {args.meeting} ({args.mic}), CC BY 4.0; transcripts from edinburghcstr/ami ihm test",
                 "rows": [{"start_ms": round(r["begin_time"] * 1000), "end_ms": round(r["end_time"] * 1000),
                           "text": r["text"], "speaker": r["speaker_id"]} for r in segments]}
    source = {"audio_url": url, "audio_download_sha256": sha256(data), "audio_bytes": len(data),
              "transcripts": "edinburghcstr/ami, config ihm, split test, rows API",
              "transcripts_revision": revision("edinburghcstr/ami"), "segments": len(segments),
              "licence": "CC BY 4.0 (AMI Meeting Corpus)"}
    write(Path(args.into), data, reference, source)


def golos(args: argparse.Namespace) -> None:
    wanted = args.minutes * 60.0
    picked, clips, total = [], [], 0.0
    offset = 0
    # One page of rows at a time, each utterance's WAV fetched from the viewer's cached assets.
    while total < wanted:
        batch = page(GOLOS, "default", "test", offset)
        if not batch:
            break
        for item in batch:
            row = item["row"]
            wav = get(row["audio"][0]["src"])
            samples, rate = pcm16(wav)
            assert rate == fixture.SAMPLE_RATE, rate
            clip = fixture.trimmed(fixture.leveled(array.array("f", (x / 32768.0 for x in samples))))
            picked.append({"row_idx": item["row_idx"], "text": row["transcription"], "sha256": sha256(wav)})
            clips.append(clip)
            total += len(clip) / fixture.SAMPLE_RATE + fixture.GAP_IN_GROUP_S
            if total >= wanted:
                break
        offset += len(batch)
    durations = [len(c) / fixture.SAMPLE_RATE for c in clips]
    starts = fixture.layout(durations)
    out = [0.0] * round((starts[-1] + durations[-1]) * fixture.SAMPLE_RATE)
    for clip, start in zip(clips, starts):
        at = round(start * fixture.SAMPLE_RATE)
        out[at:at + len(clip)] = clip
    reference = {"format": FORMAT, "language": "ru",
                 "source": f"Golos farfield test (SberDevices), {GOLOS}, first {len(picked)} utterances",
                 "rows": [{"start_ms": round(s * 1000), "end_ms": round((s + d) * 1000), "text": p["text"],
                           "golos_row": p["row_idx"]} for p, s, d in zip(picked, starts, durations)]}
    source = {"dataset": GOLOS, "revision": revision(GOLOS), "split": "test", "utterances": picked,
              "licence": "Golos: public license with attribution and conditions reserved (SberDevices)"}
    write(Path(args.into), fixture.pcm16_wav(out), reference, source)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("ami", "golos"))
    parser.add_argument("--meeting", default="ES2004a")
    parser.add_argument("--mic", default="Mix-Headset")
    parser.add_argument("--minutes", type=float, default=15.0)
    parser.add_argument("--into", required=True)
    args = parser.parse_args()
    {"ami": ami, "golos": golos}[args.kind](args)


if __name__ == "__main__":
    main()
