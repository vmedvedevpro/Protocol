import unittest

from tests.helpers import piece, row, run
from kit.accuracy import Errors, char_errors, place_deletions, score, word_errors, word_times


class WordErrorsTest(unittest.TestCase):
    def test_a_substitution_and_a_deletion(self):
        errors, deleted = word_errors("a b c d".split(), "a x c".split())
        self.assertEqual(errors, Errors(4, substitutions=1, deletions=1, insertions=0))
        self.assertEqual(errors.rate, 0.5)
        self.assertEqual(deleted, [(3, 4)])

    def test_an_insertion(self):
        errors, deleted = word_errors(["a", "b"], ["a", "b", "c"])
        self.assertEqual(errors, Errors(2, insertions=1))
        self.assertEqual(deleted, [])

    def test_empty_sides(self):
        self.assertEqual(word_errors([], ["a"]), (Errors(0, insertions=1), []))
        self.assertIsNone(Errors(0, insertions=1).rate)
        self.assertEqual(word_errors(["a", "b"], []), (Errors(2, deletions=2), [(0, 2)]))

    def test_characters(self):
        self.assertEqual(char_errors("кот", "кит"), Errors(3, substitutions=1))


class WordTimesTest(unittest.TestCase):
    def test_words_are_spread_over_their_row(self):
        self.assertEqual(word_times([row(0, 6000, "раз, два, три"), row(10_000, 11_000, "четыре")]),
                         [1000.0, 3000.0, 5000.0, 10_500.0])


class PlaceDeletionsTest(unittest.TestCase):
    def test_outside_at_an_edge_and_inside(self):
        pieces = [piece("t", 1000, 9000), piece("t", 12_000, 20_000)]
        times = [500.0, 1500.0, 5000.0, 8500.0, 10_000.0]
        placed = place_deletions("t", [(0, 5)], times, pieces)
        self.assertEqual((placed.outside_pieces, placed.at_piece_edges, placed.inside_pieces), (2, 2, 1))
        self.assertEqual([(s.track, s.start_ms, s.words) for s in placed.lost_stretches], [("t", 500.0, 5)])

    def test_fewer_than_five_missing_words_are_no_lost_stretch(self):
        placed = place_deletions("t", [(0, 4)], [5000.0] * 4, [piece("t", 0, 10_000)])
        self.assertEqual((placed.inside_pieces, placed.lost_stretches), (4, []))


class ScoreTest(unittest.TestCase):
    def test_tracks_are_aligned_apart_and_pooled(self):
        result = run(
            piece("microphone", 0, 10_000, (0, 5000, "Привет, мир!")),
            # Dropped as a silence hallucination: the pass stores nothing of it.
            piece("microphone", 10_000, 12_000, (10_000, 12_000, "you"), dropped=True),
            piece("system audio", 0, 8000, (0, 4000, "Ёлка зелёная")),
            tracks=("microphone", "system audio"),
        )
        reference = [row(0, 6000, "привет мир всем", "microphone"), row(0, 4000, "елка зеленая", "system audio")]
        accuracy = score(result, reference)
        self.assertEqual(accuracy.tracks["microphone"], Errors(3, deletions=1))
        self.assertEqual(accuracy.tracks["system audio"], Errors(2))
        self.assertEqual(accuracy.words.rate, 1 / 5)
        # " всем" is five characters of 15 + 12.
        self.assertEqual(accuracy.characters, Errors(27, deletions=5))
        # "всем" is the last of three words over 0–6 s, at 5 s: inside the 0–10 s piece.
        self.assertEqual(accuracy.deletions.inside_pieces, 1)

    def test_only_reference_rows_inside_the_span_count(self):
        result = run(piece("mixed audio", 1000, 3000, (1000, 3000, "два")), span_ms=(1000, 5000))
        reference = [row(0, 1000, "один"), row(1000, 3000, "два"), row(5000, 6000, "три")]
        self.assertEqual(score(result, reference).words, Errors(1))


if __name__ == "__main__":
    unittest.main()
