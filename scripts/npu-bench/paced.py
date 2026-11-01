"""The live-like sustained scenario: one piece every `period` seconds, at real-time pace, as the live worker gets
them while a meeting is recorded.

The pieces are consecutive `window`-second windows of the fixture, from its start and around again, so every
engine gets the same audio at the same cadence. A call that takes longer than the period delays the next one (the
live queue would grow); the summary counts those.
"""

import time

import numpy as np

from marks import phase

RATE = 16000


def windows(audio: np.ndarray, total_s: float, window_s: float) -> list[np.ndarray]:
    size = int(window_s * RATE)
    looped = np.concatenate([audio] * (int(total_s * RATE) // len(audio) + 2))
    return [looped[i * size:(i + 1) * size] for i in range(int(total_s // window_s))]


def run(transcribe, pieces: list[np.ndarray], period_s: float) -> dict:
    """Calls `transcribe(samples) -> text` once per period; returns each call's latency and text."""
    latencies, texts, late = [], [], 0
    with phase("paced", audio_s=len(pieces) * len(pieces[0]) / RATE, calls=len(pieces), period_s=period_s) as mark:
        start = time.perf_counter()
        for i, samples in enumerate(pieces):
            due = start + i * period_s
            now = time.perf_counter()
            if now < due:
                time.sleep(due - now)
            else:
                late += i > 0
            began = time.perf_counter()
            texts.append(transcribe(samples))
            latencies.append((time.perf_counter() - began) * 1000.0)
        # The phase lasts whole periods, so that its average power is that of the meeting, idle gaps included.
        end = start + len(pieces) * period_s
        if time.perf_counter() < end:
            time.sleep(end - time.perf_counter())
        mark.update(late_calls=late, latency_ms_median=round(float(np.median(latencies)), 1),
                    latency_ms_p95=round(float(np.percentile(latencies, 95)), 1),
                    latency_ms_max=round(max(latencies), 1), latency_ms=[round(x, 1) for x in latencies])
    return {"latency_ms": [round(x, 1) for x in latencies], "texts": texts, "late_calls": late,
            "latency_ms_median": round(float(np.median(latencies)), 1), "latency_ms_p95":
            round(float(np.percentile(latencies, 95)), 1), "busy_share": round(sum(latencies) / 1000 /
                                                                               (len(pieces) * period_s), 3)}
