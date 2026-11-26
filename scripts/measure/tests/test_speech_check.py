import unittest

from kit import fixture
from kit.speech_check import halves, split_frame


class HalvesTest(unittest.TestCase):
    def test_the_words_up_to_the_only_comma(self):
        self.assertEqual(halves("Since students are often critical, the writer strives."),
                         ("Since students are often critical,", "the writer strives."))

    def test_a_sentence_without_one_comma_is_refused(self):
        with self.assertRaises(ValueError):
            halves("No comma here.")
        with self.assertRaises(ValueError):
            halves("One, two, three.")


class SplitFrameTest(unittest.TestCase):
    def test_the_middle_of_the_longest_pause_in_the_middle_half(self):
        frame = fixture.FRAME
        loud, quiet = [0.5] * frame, [0.0] * frame
        # 100 frames: speech, a short pause at 20 (outside the middle half), a long one at 45-55.
        frames = [loud] * 100
        for index in (20, 21, 22, 23, 24, 25, 26, 27, 28, 29):
            frames[index] = quiet
        for index in range(45, 56):
            frames[index] = quiet
        clip = [sample for one in frames for sample in one]
        self.assertEqual(split_frame(clip), 50)

    def test_a_reading_without_a_pause_is_refused(self):
        with self.assertRaises(ValueError):
            split_frame([0.5] * fixture.FRAME * 50)


if __name__ == "__main__":
    unittest.main()
