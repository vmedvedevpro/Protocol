"""Correctness checks of a WhisperPipeline that reuses state between calls (openvino#37937), on one instance:

    python whisper_checks.py --model DIR --device NPU --ru RU.wav --en EN.wav --out CHECKS.json [--cache DIR]

1. Language switch: a Russian piece, then an English one, both with the language left to detection, then the
   English one with the language given. A pipeline that carries the first call's language over writes the second
   in Russian (or translated); the share of Cyrillic letters in each text shows which.
2. Long audio: the first 60 s of the Russian fixture in one call, with and without timestamps. A pipeline that
   reads only the first 30 s returns about half the words, and its last timestamp stays under 30 s.
3. Drift: the same 6 s piece 20 times in a row, then two pieces alternating 10 times each; the number of distinct
   texts per piece (1 means no drift).

Run it on the NPU, the GPU and the CPU and compare: the CPU and GPU pipelines are the control.
"""

import argparse
import json
import time
from pathlib import Path

import openvino_genai as ov_genai

from whisper_ov import read_wav

RATE = 16000


def cyrillic_share(text: str) -> float:
    letters = [c for c in text if c.isalpha()]
    return round(sum("Ѐ" <= c <= "ӿ" for c in letters) / max(len(letters), 1), 3)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--ru", type=Path, required=True)
    parser.add_argument("--en", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cache", type=Path)
    args = parser.parse_args()
    properties = {"CACHE_DIR": str(args.cache)} if args.cache else {}
    started = time.perf_counter()
    pipe = ov_genai.WhisperPipeline(str(args.model), args.device, **properties)
    report = {"device": args.device, "load_s": round(time.perf_counter() - started, 1)}
    ru, en = read_wav(args.ru), read_wav(args.en)

    def call(samples, language=None, timestamps=False):
        config = pipe.get_generation_config()
        config.task = "transcribe"
        config.language = language
        config.return_timestamps = timestamps
        result = pipe.generate(samples, config)
        text = result.texts[0].strip()
        entry = {"text": text, "cyrillic": cyrillic_share(text), "words": len(text.split())}
        if timestamps and result.chunks:
            entry["last_end_s"] = round(max(chunk.end_ts for chunk in result.chunks), 2)
        return entry

    ru_piece, en_piece = ru[:6 * RATE], en[:6 * RATE]
    report["language_switch"] = {"ru_auto": call(ru_piece), "en_auto_after_ru": call(en_piece),
                                 "en_given": call(en_piece, "<|en|>"), "ru_auto_again": call(ru_piece)}
    report["long_audio"] = {"ru_60s_no_timestamps": call(ru[:60 * RATE], "<|ru|>"),
                            "ru_60s_timestamps": call(ru[:60 * RATE], "<|ru|>", True),
                            "ru_30s_no_timestamps": call(ru[:30 * RATE], "<|ru|>")}
    same = [call(ru_piece, "<|ru|>")["text"] for _ in range(20)]
    second = ru[6 * RATE:12 * RATE]
    alternating = [call(p, "<|ru|>")["text"] for _ in range(10) for p in (ru_piece, second)]
    report["drift"] = {"same_piece_distinct_texts": len(set(same)),
                       "alternating_distinct_texts": [len(set(alternating[0::2])), len(set(alternating[1::2]))],
                       "same_piece_texts": sorted(set(same)), "alternating_texts": sorted(set(alternating))}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "drift"} | {"drift": {
        k: v for k, v in report["drift"].items() if "distinct" in k}}, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
