import unittest

from kit.text import normalize, words


class NormalizeTest(unittest.TestCase):
    def test_case_punctuation_and_yo_do_not_count(self):
        self.assertEqual(normalize("Ёлка, зелёная!  «Да» — сказал он…"), "елка зеленая да сказал он")

    def test_decomposed_letters_compare_as_composed_ones(self):
        decomposed = "ёлка йод"
        self.assertEqual(normalize(decomposed), normalize("ёлка йод"))
        self.assertEqual(normalize(decomposed), "елка йод")
        self.assertEqual(words("ﬁle ２５"), ["file", "25"])

    def test_digits_stay_as_written(self):
        self.assertEqual(words("В 2024 году, 25%."), ["в", "2024", "году", "25"])

    def test_hyphens_and_apostrophes_split_words(self):
        self.assertEqual(words("Кто-то said: don't."), ["кто", "то", "said", "don", "t"])

    def test_nothing_but_marks_is_empty(self):
        self.assertEqual(words(" ... — !"), [])


if __name__ == "__main__":
    unittest.main()
