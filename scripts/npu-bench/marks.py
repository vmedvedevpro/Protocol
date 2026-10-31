"""Phase marks a workload writes for `bench.py`: the wall-clock edges of its load, warm-up and timed runs.

`bench.py` passes the file in `BENCH_MARKS`; without it (a workload run alone) the marks are not written.
"""

import json
import os
import time
from contextlib import contextmanager


@contextmanager
def phase(name: str, **fields):
    """Marks the block as phase `name`. Fields set on the yielded dict inside the block (such as `audio_s`, the
    audio the phase transcribed) are written with it."""
    record = dict(fields)
    t0 = time.time()
    yield record
    t1 = time.time()
    path = os.environ.get("BENCH_MARKS")
    if path:
        with open(path, "a", encoding="utf-8") as file:
            file.write(json.dumps({"phase": name, "t0": t0, "t1": t1, **record}) + "\n")
