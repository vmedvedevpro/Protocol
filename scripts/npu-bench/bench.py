"""Runs one workload under the power sampler, after an idle baseline, and reports the energy of its phases.

    python bench.py --out DIR [--idle 60] -- COMMAND ...
    python bench.py --out DIR --analyse          (again, from the files of an earlier run)

Writes into DIR: `samples.jsonl` (sampler.py), `log.txt` (the command's merged stdout and stderr, each line with
its arrival time), `marks.jsonl` (the phases the workload marks, marks.py) and `power.json`:

- `idle`: the average power per rail over the idle baseline right before the command (60 s by default, with the
  sampler and this script running, so their own cost cancels out of the "above idle" numbers);
- one entry per phase: its length, energy and average power per rail, the package power and energy above idle,
  joules above idle per minute of audio when the phase names its audio (`audio_s`), and the mean utilization of
  the CPU, the Arc iGPU's engines and the NPU's compute engine, with the processes that used the NPU.

Phases come from the workload's marks, the whole command (`process`), and, for the Rust measurement kit, the timed
loop of each setting: it ends when the kit prints `wrote <setting>.json` and lasts the sum of its pieces' times.
"""

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time
from bisect import bisect_left
from pathlib import Path

import pdh

HERE = Path(__file__).resolve().parent
KIT_WROTE = re.compile(r"wrote (.+\.json)\s*$")


def record(out: Path, idle_s: float, command: list[str]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    stop = out / "stop"
    stop.unlink(missing_ok=True)
    (out / "marks.jsonl").unlink(missing_ok=True)
    sampler = subprocess.Popen([sys.executable, str(HERE / "sampler.py"), str(out / "samples.jsonl"), str(stop)],
                               cwd=HERE)
    time.sleep(2.0)
    meta = {"command": command, "idle": [time.time(), None]}
    time.sleep(idle_s)
    meta["idle"][1] = time.time()
    env = dict(os.environ, BENCH_MARKS=str(out / "marks.jsonl"), PYTHONUNBUFFERED="1")
    started = time.time()
    with (out / "log.txt").open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
        for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            log.write(f"{time.time():.3f} {line}\n")
            log.flush()
            print(line, flush=True)
        code = process.wait()
    meta["process"] = [started, time.time()]
    meta["exit_code"] = code
    time.sleep(2.0)
    stop.touch()
    sampler.wait(timeout=30)
    (out / "meta.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    if code != 0:
        print(f"bench: the command exited with {code}", file=sys.stderr)


class Samples:
    def __init__(self, path: Path) -> None:
        self.energy: list[tuple[float, dict[str, int]]] = []
        self.usage: list[dict] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if "e" in row:
                self.energy.append((row["t"], row["e"]))
            elif "eng" in row:
                self.usage.append(row)
        self.times = [t for t, _ in self.energy]

    def at(self, t: float) -> dict[str, float]:
        """Cumulative energy per rail (J) at time t, interpolated between the two readings around it."""
        i = min(max(bisect_left(self.times, t), 1), len(self.times) - 1)
        (ta, ea), (tb, eb) = self.energy[i - 1], self.energy[i]
        share = 0.0 if tb == ta else min(max((t - ta) / (tb - ta), 0.0), 1.0)
        return {rail: (ea[rail] + (eb[rail] - ea[rail]) * share) * pdh.PWH_TO_J for rail in ea}

    def joules(self, t0: float, t1: float) -> dict[str, float]:
        a, b = self.at(t0), self.at(t1)
        return {rail: b[rail] - a[rail] for rail in a}

    def utilization(self, t0: float, t1: float) -> dict:
        rows = [row for row in self.usage if t0 <= row["t"] <= t1]
        if not rows:
            return {}
        keys = sorted({key for row in rows for key in row["eng"]})
        def value(row, key):
            # Samples taken before pdh.engines dropped implausible readings (> 100 %) count as missing.
            reading = row["eng"].get(key, 0.0)
            return reading if reading <= 100.0 else None

        mean = {key: round(statistics.mean(v for row in rows if (v := value(row, key)) is not None), 1)
                for key in keys
                if key.split(".")[-1] in ("3D", "Compute", "Neural")}
        mean["cpu"] = round(sum(row["cpu"] for row in rows) / len(rows), 1)
        pids = sorted({pid for row in rows for pid in row.get("npu_pids", {})})
        return {"mean_pct": mean, "npu_pids": pids, "samples": len(rows)}


def kit_phases(out: Path) -> list[dict]:
    """The timed loop of each setting the Rust kit wrote: it ends at `wrote <setting>.json` and lasts the sum of
    its transcribed pieces' times (skipped pieces take no measurable time)."""
    phases = []
    for line in (out / "log.txt").read_text(encoding="utf-8").splitlines():
        stamp, _, text = line.partition(" ")
        match = KIT_WROTE.search(text)
        if not match:
            continue
        data = json.loads(Path(match.group(1)).read_text(encoding="utf-8"))
        if "pieces" not in data:
            continue
        timing = data["timing"]
        t1 = float(stamp)
        name = f"kit:{Path(match.group(1)).parent.name}/{data['setting']}"
        phases.append({"phase": name, "t0": t1 - timing["transcription_ms"] / 1000.0, "t1": t1,
                       "audio_s": timing["speech_ms"] / 1000.0})
    return phases


def analyse(out: Path) -> dict:
    samples = Samples(out / "samples.jsonl")
    meta = json.loads((out / "meta.json").read_text(encoding="utf-8"))
    i0, i1 = meta["idle"]
    idle_w = {rail: j / (i1 - i0) for rail, j in samples.joules(i0, i1).items()}
    phases = [{"phase": "process", "t0": meta["process"][0], "t1": meta["process"][1]}]
    marks = out / "marks.jsonl"
    if marks.exists():
        phases += [json.loads(line) for line in marks.read_text(encoding="utf-8").splitlines() if line.strip()]
    phases += kit_phases(out)
    result = {"idle_s": round(i1 - i0, 1), "idle_w": {k: round(v, 3) for k, v in idle_w.items()},
              "idle_utilization": samples.utilization(i0, i1), "phases": []}
    for mark in phases:
        t0, t1 = mark["t0"], mark["t1"]
        seconds = t1 - t0
        joules = samples.joules(t0, t1)
        entry = {key: value for key, value in mark.items() if key not in ("t0", "t1")}
        entry.update(seconds=round(seconds, 3), joules={k: round(v, 1) for k, v in joules.items()},
                     watts={k: round(v / seconds, 2) for k, v in joules.items()},
                     pkg_above_idle_w=round(joules["PKG"] / seconds - idle_w["PKG"], 2),
                     pkg_above_idle_j=round(joules["PKG"] - idle_w["PKG"] * seconds, 1),
                     utilization=samples.utilization(t0, t1))
        if mark.get("audio_s"):
            entry["pkg_above_idle_j_per_audio_min"] = round(entry["pkg_above_idle_j"] / (mark["audio_s"] / 60), 1)
            entry["x_realtime"] = round(mark["audio_s"] / seconds, 2)
        result["phases"].append(entry)
    (out / "power.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def main() -> None:
    # The kit's log has emoji; the console's code page would stop the relay mid-run.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--idle", type=float, default=60.0)
    parser.add_argument("--analyse", action="store_true")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.analyse:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        record(args.out, args.idle, command)
    result = analyse(args.out)
    print(f"idle: {result['idle_w']}")
    for phase in result["phases"]:
        extra = (f"  {phase['x_realtime']}x  {phase['pkg_above_idle_j_per_audio_min']} J/audio-min"
                 if "x_realtime" in phase else "")
        print(f"{phase['phase']:<28} {phase['seconds']:>8.1f} s  PKG {phase['watts']['PKG']:>6.2f} W  "
              f"+{phase['pkg_above_idle_w']:>6.2f} W{extra}  {phase['utilization'].get('mean_pct', {})}")


if __name__ == "__main__":
    main()
