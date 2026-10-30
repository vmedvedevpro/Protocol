import json
import tempfile
import unittest
from pathlib import Path

from kit.runs import Reference, Row, by_track, clip, load_diarization, load_reference, load_run
from tests.helpers import row, run

RUN = {
    "format": 1, "setting": "live", "model": "m.bin", "acceleration": "CPU processing only", "optimized": True,
    "language": "ru", "vocabulary": False, "span_ms": [0.0, 10_000.0],
    "tracks": [{"label": "microphone", "speaker_hint": "You", "language": None},
               {"label": "system audio", "speaker_hint": "Guest", "language": None}],
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
        self.assertEqual(run.rows(), [row(0.0, 5000.0, "Да.", "system audio", [2, 1])])
        self.assertEqual(run.decodings(), {"greedy": 1})

    def test_a_reference_is_a_run_or_a_list_of_rows(self):
        self.assertEqual(load_reference(self.write(RUN)), Reference(load_run(self.write(RUN)).rows(), (0.0, 10_000.0)))
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
        reference = Reference([], (1000.0, 5000.0))
        reference.check(run(span_ms=(1000.0, 3000.0)))
        for span in ((0.0, 3000.0), (2000.0, 6000.0), None):
            with self.assertRaises(ValueError):
                reference.check(run(span_ms=span))
        Reference([]).check(run(span_ms=None))


if __name__ == "__main__":
    unittest.main()
