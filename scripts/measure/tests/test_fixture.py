import array
import struct
import unittest

from kit.fixture import FIXTURES, Utterance, choose, float_wav_samples, layout, leveled


def float_wav(samples: list[float], rate: int = 16_000) -> bytes:
    data = array.array("f", samples).tobytes()
    fmt = struct.pack("<HHIIHHH", 3, 1, rate, rate * 4, 4, 32, 0)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"fact" + struct.pack("<II", 4, len(samples))
    chunks += b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


class ChooseTest(unittest.TestCase):
    def test_voices_alternate_and_each_sentence_is_read_once(self):
        utterances = [
            Utterance("1", "a.wav", "one", "FEMALE"),
            Utterance("1", "b.wav", "one", "MALE"),
            Utterance("2", "c.wav", "two", "FEMALE"),
            Utterance("3", "d.wav", "three", "MALE"),
            Utterance("4", "e.wav", "four", "FEMALE"),
        ]
        # b.wav is a man's voice, but its sentence was read already.
        self.assertEqual([u.file for u in choose(utterances, 3)], ["a.wav", "d.wav", "c.wav"])
        with self.assertRaises(ValueError):
            choose(utterances, 4)


class LayoutTest(unittest.TestCase):
    def test_short_gaps_inside_a_group_of_three_and_long_ones_between(self):
        starts = layout([10.0, 10.0, 10.0, 5.0])
        self.assertEqual([round(s, 3) for s in starts], [0.0, 10.6, 21.2, 34.2])


class LevelTest(unittest.TestCase):
    def test_a_sentence_is_scaled_to_the_common_peak(self):
        self.assertEqual(leveled(array.array("f", [0.0, 0.125, -0.25])), [0.0, 0.25, -0.5])
        self.assertEqual(leveled(array.array("f", [0.0, 0.0])), [0.0, 0.0])


class FloatWavTest(unittest.TestCase):
    def test_samples_are_read_after_the_fact_chunk(self):
        self.assertEqual(list(float_wav_samples(float_wav([0.0, 0.5, -0.25]))), [0.0, 0.5, -0.25])

    def test_another_rate_is_refused(self):
        with self.assertRaises(ValueError):
            float_wav_samples(float_wav([0.0], rate=48_000))


class PinsTest(unittest.TestCase):
    def test_cache_names_say_language_and_split(self):
        self.assertEqual([(f.transcripts.name, f.audio.name) for f in FIXTURES], [
            ("fleurs-ru_ru-dev.tsv", "fleurs-ru_ru-dev.tar.gz"),
            ("fleurs-en_us-dev.tsv", "fleurs-en_us-dev.tar.gz"),
        ])


if __name__ == "__main__":
    unittest.main()
