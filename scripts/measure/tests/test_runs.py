import json
import tempfile
import unittest
from pathlib import Path

from kit.runs import by_track, in_span, load_reference, load_run
from tests.helpers import row

RUN = {
    "format": 1, "setting": "live", "model": "m.bin", "acceleration": "CPU processing only", "optimized": True,
    "language": "ru", "vocabulary": False, "span_ms": [0.0, 10_000.0],
    "tracks": [{"label": "microphone", "speaker_hint": "You", "language": None},
               {"label": "system audio", "speaker_hint": "Guest", "language": None}],
    "timing": {"warmup_ms": 1.0, "vad_ms": 2.0, "detection_ms": 0.0, "transcription_ms": 3.0, "speech_ms": 4.0},
    "pieces": [
        {"track": "system audio", "start_ms": 0.0, "end_ms": 5000.0, "skipped": None, "dropped": False,
         "wall_ms": 3.0, "rows": [{"start_ms": 0.0, "end_ms": 5000.0, "text": "Да.", "speakers": [2, 1]}]},
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

    def test_a_reference_is_a_run_or_a_list_of_rows(self):
        self.assertEqual(load_reference(self.write(RUN)), load_run(self.write(RUN)).rows())
        human = {"rows": [{"start_ms": 0, "end_ms": 900, "text": "Раз.", "voice": "female"}]}
        self.assertEqual(load_reference(self.write(human)), [row(0, 900, "Раз.")])

    def test_another_format_is_refused(self):
        with self.assertRaises(ValueError):
            load_run(self.write({**RUN, "format": 2}))


class GroupingTest(unittest.TestCase):
    def test_rows_without_a_track_belong_to_the_only_track(self):
        rows = [row(5, 6, "b"), row(1, 2, "a")]
        self.assertEqual(by_track(rows, ("mixed audio",)), {"mixed audio": [row(1, 2, "a"), row(5, 6, "b")]})
        with self.assertRaises(ValueError):
            by_track(rows, ("microphone", "system audio"))

    def test_a_span_keeps_rows_that_start_inside(self):
        rows = [row(0, 2000, "a"), row(1000, 3000, "b"), row(3000, 4000, "c")]
        self.assertEqual(in_span(rows, (1000, 3000)), [row(1000, 3000, "b")])
        self.assertEqual(in_span(rows, None), rows)


if __name__ == "__main__":
    unittest.main()
