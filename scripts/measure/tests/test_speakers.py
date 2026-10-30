import unittest

from kit.runs import Timeline, Turn
from kit.speakers import score, single_speaker_slices
from tests.helpers import piece, run

TRACK = "system audio"
# Speaker 0 for the first second, speaker 1 for the next.
TIMELINE = Timeline((TRACK,), (Turn(0, 1000, 0), Turn(1000, 2000, 1)))


class SlicesTest(unittest.TestCase):
    def test_slices_where_two_talk_are_left_out(self):
        timeline = Timeline((TRACK,), (Turn(0, 1000, 0), Turn(500, 1000, 1)))
        slices = single_speaker_slices(timeline, (0, 1000))
        self.assertEqual(len(slices), 5)
        self.assertEqual({speaker for _, speaker in slices}, {0})

    def test_only_slices_of_the_span_count(self):
        slices = single_speaker_slices(TIMELINE, (500, 1500))
        self.assertEqual([middle for middle, _ in slices], [550 + 100 * i for i in range(10)])
        self.assertEqual([speaker for _, speaker in slices], [0] * 5 + [1] * 5)


class ScoreTest(unittest.TestCase):
    def test_a_row_over_a_change_of_speaker(self):
        result = run(
            # 0–1.5 s labelled speaker 0 holds half a second of speaker 1.
            piece(TRACK, 0, 2000, (0, 1500, "раз два", [0]), (1500, 2000, "три", [1])),
            tracks=(TRACK,),
        )
        speakers = score(result, TIMELINE)
        self.assertEqual((speakers.rows, speakers.mean_row_s), (2, 1.0))
        self.assertEqual(speakers.covered, 1.0)
        # 15 of 20 slices: the first row's 10 of speaker 0 and the second row's 5.
        self.assertEqual(speakers.agreement, 0.75)
        self.assertEqual((speakers.turn_rows, speakers.shared_rows), (1, 0))

    def test_speech_outside_rows_is_not_covered(self):
        result = run(piece(TRACK, 0, 1000, (0, 1000, "раз", [0, 1])), tracks=(TRACK,))
        speakers = score(result, TIMELINE)
        self.assertEqual((speakers.covered, speakers.agreement, speakers.shared_rows), (0.5, 1.0, 1))

    def test_a_system_row_the_user_talks_over(self):
        # The remote speaker (1) answers for 0.6 s; the user (0) talks from 0.4 s to 2 s.
        timeline = Timeline(("microphone", TRACK), (Turn(0, 600, 1), Turn(400, 2000, 0)))
        result = run(
            piece("microphone", 400, 2000, (400, 2000, "ну вот смотри", [0])),
            # The system track's row spans the user's speech, so the user is its main speaker.
            piece(TRACK, 0, 2000, (0, 2000, "да", [0, 1])),
            tracks=("microphone", TRACK),
        )
        speakers = score(result, timeline)
        # 18 single-speaker slices: 4 of speaker 1 under the system row, 14 of the user under the microphone row.
        self.assertEqual(speakers.covered, 1.0)
        self.assertAlmostEqual(speakers.agreement, 14 / 18)
        # The user over the system row is crosstalk, as the remote speaker over the microphone row is: each row
        # holds one speaker of its own track.
        self.assertEqual((speakers.rows, speakers.turn_rows, speakers.shared_rows), (2, 0, 1))

    def test_two_remote_speakers_in_a_system_row_are_a_turn_change(self):
        timeline = Timeline(("microphone", TRACK), (Turn(0, 1000, 1), Turn(1000, 2000, 2)))
        result = run(piece(TRACK, 0, 2000, (0, 2000, "да нет", [1, 2])), tracks=("microphone", TRACK))
        self.assertEqual(score(result, timeline).turn_rows, 1)

    def test_no_speech_no_score(self):
        self.assertIsNone(score(run(piece(TRACK, 0, 1000, (0, 1000, "раз", [0])), tracks=(TRACK,)),
                                Timeline((TRACK,), ())))

    def test_a_timeline_of_other_tracks_is_refused(self):
        with self.assertRaises(ValueError):
            score(run(piece(TRACK, 0, 1000, (0, 1000, "раз", [0])), tracks=(TRACK,)), Timeline(("mixed audio",), ()))


if __name__ == "__main__":
    unittest.main()
