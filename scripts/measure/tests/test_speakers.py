import unittest

from kit.runs import Timeline, Turn
from kit.speakers import score, single_speaker_slices
from tests.helpers import piece, run

TRACK = "system audio"
# Speaker 0 for the first second, speaker 1 for the next.
TIMELINE = Timeline(TRACK, 0, 2000, (Turn(0, 1000, 0), Turn(1000, 2000, 1)))


class SlicesTest(unittest.TestCase):
    def test_slices_where_two_talk_are_left_out(self):
        timeline = Timeline(TRACK, 0, 1000, (Turn(0, 1000, 0), Turn(500, 1000, 1)))
        slices = single_speaker_slices(timeline)
        self.assertEqual(len(slices), 5)
        self.assertEqual({speaker for _, speaker in slices}, {0})


class ScoreTest(unittest.TestCase):
    def test_a_row_over_a_change_of_speaker(self):
        result = run(
            # 0–1.5 s labelled speaker 0 holds half a second of speaker 1.
            piece(TRACK, 0, 2000, (0, 1500, "раз два", [0]), (1500, 2000, "три", [1])),
            tracks=(TRACK,),
        )
        speakers = score(result, {TRACK: TIMELINE})
        self.assertEqual((speakers.rows, speakers.mean_row_s), (2, 1.0))
        self.assertEqual(speakers.covered, 1.0)
        # 15 of 20 slices: the first row's 10 of speaker 0 and the second row's 5.
        self.assertEqual(speakers.agreement, 0.75)
        self.assertEqual((speakers.turn_rows, speakers.shared_rows), (1, 0))

    def test_speech_outside_rows_is_not_covered(self):
        result = run(piece(TRACK, 0, 1000, (0, 1000, "раз", [0, 1])), tracks=(TRACK,))
        speakers = score(result, {TRACK: TIMELINE})
        self.assertEqual((speakers.covered, speakers.agreement, speakers.shared_rows), (0.5, 1.0, 1))

    def test_no_timeline_no_score(self):
        self.assertIsNone(score(run(piece(TRACK, 0, 1000, (0, 1000, "раз", [0])), tracks=(TRACK,)), {}))


if __name__ == "__main__":
    unittest.main()
