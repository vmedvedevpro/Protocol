import unittest

from kit.failures import count, hallucinations, is_short_output, loop_phrase, repeated_words
from tests.helpers import piece


class ShortOutputTest(unittest.TestCase):
    def test_three_seconds_with_two_words_is_short(self):
        self.assertTrue(is_short_output(piece("t", 0, 3000, (0, 3000, "Да, конечно."))))
        self.assertFalse(is_short_output(piece("t", 0, 2900, (0, 2900, "Да."))))
        self.assertFalse(is_short_output(piece("t", 0, 5000, (0, 5000, "Да, это так."))))


class LoopTest(unittest.TestCase):
    def test_a_word_four_times_or_a_phrase_three_times_is_a_loop(self):
        self.assertEqual(loop_phrase("ну да да да да".split()), "да")
        self.assertEqual(loop_phrase("и вот так и вот так и вот так".split()), "и вот так")

    def test_ordinary_repeats_are_no_loop(self):
        self.assertIsNone(loop_phrase("да да да нет".split()))
        self.assertIsNone(loop_phrase("в твоем в твоем доме".split()))


class HallucinationTest(unittest.TestCase):
    def test_known_phrases_are_found_from_a_word_start(self):
        self.assertEqual(hallucinations("Редактор субтитров А.Синецкая"), ["субтитры", "subtitle credit names"])
        self.assertEqual(hallucinations("Thanks for watching!"), ["thanks for watching"])
        self.assertEqual(hallucinations("  You. "), ["a lone “you”"])

    def test_ordinary_speech_has_none(self):
        self.assertEqual(hallucinations("Thank you, see you tomorrow."), [])
        self.assertEqual(hallucinations("Продолжаем, следующий вопрос."), [])


class RepeatedWordsTest(unittest.TestCase):
    def test_copies_after_the_first_are_counted(self):
        # The three-word phrase said three times: two copies, six words.
        self.assertEqual(repeated_words("мы идем дальше мы идем дальше мы идем дальше да".split()), 6)
        self.assertEqual(repeated_words("да да да да".split()), 3)

    def test_natural_repeats_are_not(self):
        self.assertEqual(repeated_words("да да да в твоем в твоем".split()), 0)


class CountTest(unittest.TestCase):
    def test_counts_over_transcribed_pieces(self):
        pieces = (
            piece("t", 0, 4000, (0, 4000, "и")),
            piece("t", 4000, 9000, (4000, 9000, "так так так так")),
            piece("t", 9000, 9050, skipped="short"),
            piece("t", 10_000, 11_000, (10_000, 11_000, "you"), dropped=True),
            piece("t", 12_000, 14_000, (12_000, 13_000, "Продолжение следует..."),
                  (13_000, 14_000, "Редактор субтитров А.Семкин")),
        )
        failures = count(pieces)
        self.assertEqual((failures.pieces, failures.short_outputs, failures.loops, failures.dropped), (4, 1, 1, 1))
        # The dropped "you" is not stored, so it is not counted; one row can hold two phrases.
        self.assertEqual(failures.hallucinated_rows, 2)
        self.assertEqual(failures.hallucinations,
                         {"продолжение следует": 1, "субтитры": 1, "subtitle credit names": 1})


if __name__ == "__main__":
    unittest.main()
