import unittest
from dataclasses import replace

from kit.report import decoding_warnings
from tests.helpers import piece, run


def decoded(*decodings: str | None):
    """A run with one piece per decoding."""
    pieces = (replace(piece("t", i * 1000, i * 1000 + 900), decoding=d) for i, d in enumerate(decodings))
    return run(*pieces, tracks=("t",))


class DecodingWarningsTest(unittest.TestCase):
    def test_a_run_that_turned_greedy_is_named(self):
        warnings = decoding_warnings([decoded("beam 5", "greedy", "greedy")], ["post-meeting"])
        self.assertEqual(warnings, ["post-meeting decoded its pieces beam 5 × 1, greedy × 2"])

    def test_two_runs_of_one_setting_decoded_differently(self):
        names = ["main/post-meeting", "branch/post-meeting"]
        warnings = decoding_warnings([decoded("beam 5"), decoded("greedy")], names)
        self.assertEqual(warnings, ["main/post-meeting decoded beam 5 × 1, but branch/post-meeting greedy × 1"])

    def test_runs_without_a_record_or_alike_raise_nothing(self):
        self.assertEqual(decoding_warnings([decoded(None), decoded("beam 5"), decoded("beam 5", "beam 5")],
                                           ["old", "main", "branch"]), [])


if __name__ == "__main__":
    unittest.main()
