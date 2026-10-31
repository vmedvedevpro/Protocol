"""Runs the Rust measurement kit's `transcribe_settings` several times, each into its own folder.

    python kit_runs.py --exe TEST_EXE --out BASE --reps 3 MEASURE_SETTINGS=post-meeting,live MEASURE_...=...

Each repeat is a new process with MEASURE_OUT=BASE/repN, so the model is loaded again every time: the first
repeat's load is the cold one, the next ones load from the OS file cache and the driver's shader cache. The
`MEASURE_*` paths must be absolute (the kit takes a relative one from the repository root).
"""

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--reps", type=int, default=3)
    parser.add_argument("--test", default="measure::transcribe_settings")
    parser.add_argument("env", nargs="*")
    args = parser.parse_args()
    env = dict(os.environ)
    env.update(item.split("=", 1) for item in args.env)
    for rep in range(1, args.reps + 1):
        env["MEASURE_OUT"] = str(args.out / f"rep{rep}")
        started = time.time()
        print(f"kit_runs: rep{rep} starts", flush=True)
        code = subprocess.call([args.exe, args.test, "--ignored", "--exact", "--nocapture"], env=env)
        print(f"kit_runs: rep{rep} exited {code} after {time.time() - started:.1f} s", flush=True)
        if code != 0:
            sys.exit(code)


if __name__ == "__main__":
    main()
