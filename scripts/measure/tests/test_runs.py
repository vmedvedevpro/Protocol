import json
import tempfile
import unittest
from pathlib import Path

from kit.runs import (Audio, Reference, Row, by_track, check_side_by_side, clip, load_diarization, load_reference,
                      load_run)
from tests.helpers import row, run

RUN = {
    "format": 1, "setting": "live", "model": "m.bin", "acceleration": "CPU processing only", "optimized": True,
    "language": "ru", "vocabulary": True, "vocabulary_sha256": "1a2b", "span_ms": [0.0, 10_000.0],
    "tracks": [{"label": "microphone", "speaker_hint": "You", "language": None,
                "audio": {"file": "mic.mp4", "bytes": 1000, "sha256": "aa"}},
               {"label": "system audio", "speaker_hint": "Guest", "language": None,
                "audio": {"file": "system.mp4", "bytes": 2000, "sha256": "bb"}}],
    "timing": {"warmup_ms": 1.0, "vad_ms": 2.0, "detection_ms": 0.0, "transcription_ms": 3.0, "speech_ms": 4.0},
    "pieces": [
        {"track": "system audio", "start_ms": 0.0, "end_ms": 5000.0, "skipped": None, "dropped": False,
         "decoding": "greedy", "wall_ms": 3.0, "rows": [{"start_ms": 0.0, "end_ms": 5000.0, "text": "Да.", "speakers": [2, 1]}]},
        {"track": "microphone", "start_ms": 6000.0, "end_ms": 6050.0, "skipped": "short", "dropped": False,
         "wall_ms": 0.0, "rows": []},
    ],
}


class LoadTest(unittest.TestCase):
    def write(self, data: dict) -> Path:
        folder = tempfile.mkdtemp()
        path = Path(folder) / "run.json"
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return path

    def test_a_run_and_its_rows(self):
        run = load_run(self.write(RUN))
        self.assertEqual((run.setting, run.tracks, run.span_ms), ("live", ("microphone", "system audio"), (0.0, 10_000.0)))
        self.assertEqual((run.language, run.vocabulary), ("ru", "1a2b"))
        self.assertEqual(run.audio, (Audio("microphone", "mic.mp4", 1000, "aa"),
                                     Audio("system audio", "system.mp4", 2000, "bb")))
        self.assertEqual(run.rows(), [row(0.0, 5000.0, "Да.", "system audio", [2, 1])])
        self.assertEqual(run.decodings(), {"greedy": 1})

    def test_a_reference_is_a_run_or_a_list_of_rows(self):
        model_run = load_run(self.write(RUN))
        self.assertEqual(load_reference(self.write(RUN)), Reference(model_run.rows(), model_run))
        human = {"rows": [{"start_ms": 0, "end_ms": 900, "text": "Раз.", "voice": "female"}]}
        self.assertEqual(load_reference(self.write(human)), Reference([row(0, 900, "Раз.")]))

    def test_a_timeline_numbers_the_user_first(self):
        diarization = {"format": 1, "engine": "nemotron", "model": "m.onnx", "tracks": ["microphone", "system audio"],
                       "wall_ms": 1.0, "speakers": 3,
                       "segments": [{"start_ms": 0.0, "end_ms": 900.0, "speaker": 2, "overlapped": False}]}
        timeline = load_diarization(self.write(diarization))
        self.assertEqual([(t.start_ms, t.speaker) for t in timeline.turns], [(0.0, 2)])
        self.assertEqual((timeline.track_of(0), timeline.track_of(2)), ("microphone", "system audio"))

    def test_another_format_is_refused(self):
        with self.assertRaises(ValueError):
            load_run(self.write({**RUN, "format": 2}))


class GroupingTest(unittest.TestCase):
    def test_rows_without_a_track_belong_to_the_only_track(self):
        rows = [row(5, 6, "b"), row(1, 2, "a")]
        self.assertEqual(by_track(rows, ("mixed audio",)), {"mixed audio": [row(1, 2, "a"), row(5, 6, "b")]})
        with self.assertRaises(ValueError):
            by_track(rows, ("microphone", "system audio"))

    def test_a_row_on_another_track_is_refused(self):
        with self.assertRaises(ValueError):
            by_track([row(1, 2, "a", "mic")], ("microphone", "system audio"))


class ClipTest(unittest.TestCase):
    def test_rows_are_kept_by_the_time_of_their_words(self):
        rows = [row(0, 1000, "a"), row(1000, 3000, "b c"), row(5000, 6000, "d")]
        self.assertEqual(clip(rows, (1000, 5000)), [row(1000, 3000, "b c")])
        self.assertEqual(clip(rows, None), rows)

    def test_a_row_across_an_edge_keeps_its_words_inside(self):
        # Word times 500, 1500, 2500 and 3500 ms.
        clipped = clip([row(0, 4000, "Раз, два, три, четыре.", "t", [1])], (1000, 3000))
        self.assertEqual(clipped, [Row("t", 1000.0, 3000.0, "два три", (1,))])

    def test_a_row_without_words_is_kept_where_it_starts(self):
        self.assertEqual(clip([row(0, 100, "..."), row(2000, 2100, "...")], (1000, 3000)), [row(2000, 2100, "...")])


class ReferenceTest(unittest.TestCase):
    def test_a_reference_must_cover_the_run(self):
        reference = Reference([], run(span_ms=(1000.0, 5000.0)))
        reference.check(run(span_ms=(1000.0, 3000.0)))
        for span in ((0.0, 3000.0), (2000.0, 6000.0), None):
            with self.assertRaises(ValueError):
                reference.check(run(span_ms=span))
        Reference([], run(span_ms=None)).check(run(span_ms=(1000.0, 3000.0)))

    def test_a_reference_must_share_the_language_and_vocabulary(self):
        reference = Reference([], run(language="ru", vocabulary="1a2b"))
        reference.check(run(language="ru", vocabulary="1a2b"))
        for other in (run(language="auto", vocabulary="1a2b"), run(language="ru"), run(language="ru", vocabulary="3c")):
            with self.assertRaises(ValueError):
                reference.check(other)

    def test_a_human_reference_is_not_checked(self):
        Reference([]).check(run(span_ms=(1000.0, 3000.0), language="auto", vocabulary="1a2b"))

    def test_a_reference_of_other_audio_is_refused(self):
        with self.assertRaises(ValueError):
            Reference([], run(audio=(AUDIO,))).check(run(audio=(OTHER_AUDIO,)))


AUDIO = Audio("mixed audio", "audio.wav", 1000, "aa")
# The same file name and size, another recording.
OTHER_AUDIO = Audio("mixed audio", "audio.wav", 1000, "cc")


class SideBySideTest(unittest.TestCase):
    def test_runs_of_the_same_audio_and_span_stand_side_by_side(self):
        check_side_by_side([run(audio=(AUDIO,), span_ms=(0.0, 5000.0))] * 2, ["main/live", "branch/live"])

    def test_runs_of_other_audio_or_another_span_are_refused(self):
        first = run(audio=(AUDIO,), span_ms=(0.0, 5000.0))
        for other in (run(audio=(OTHER_AUDIO,), span_ms=(0.0, 5000.0)), run(audio=(AUDIO,), span_ms=None)):
            with self.assertRaises(ValueError):
                check_side_by_side([first, other], ["main/live", "branch/live"])


if __name__ == "__main__":
    unittest.main()
