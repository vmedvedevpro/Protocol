"""One measurement cell (#80): a sequence of blocks under one power sampler, so that blocks of different engines
and the no-model idle between them are read on the same clock and drift cancels between neighbours.

    python cells.py --out DIR --spec CELL.json          (record, then analyse)
    python cells.py --out DIR --analyse                 (again, from the files of an earlier run)

CELL.json: `{"steps": [...], "load": [cmd...] | null, "env": {...}}`. A step is
`{"name": "idle", "kind": "idle", "seconds": 180, "settle": 20, "phase": "idle"}` (nothing runs: `settle` seconds
unmarked, then the block, marked as `phase`), `{"name": "npu", "kind": "cmd", "cmd": [...], "env": {...}}` (a
workload that marks its own phases through `marks.py` or `measure/npu.rs`, such as `resident` or `meeting`), or
`{"kind": "load-start"}` / `{"kind": "load-stop"}`: the background command `load` (the busy-GPU scenario) runs
between them; its process is reported apart, and an idle block under it is marked `load-alone`.

Writes into DIR: `samples.jsonl` (sampler.py), `cell.json` (the spec, the machine state before every step, each
step's process id, times and exit code), `marks.jsonl`, one `step-<i>-<name>.log` per command, and `cell-power.json`:
per block its power per RAPL rail, the package's rest (PKG - PP0 - PP1: NPU, fabric, memory controller, ...),
the median over 10 s bins next to the mean, engine utilization, and the background:

- `other_cpu_pct`: total CPU busy minus the cell's own processes (the workload, the load, the sampler, this
  driver), in % of all logical processors;
- `other_gpu_pct`: other processes' Arc 3D + Compute utilization, from the per-process engine instances;
- the five busiest other processes, C-state residency, interrupt and context-switch rates, thermal zones.

A block is flagged when its background exceeds the thresholds below; `summarise.py` drops flagged blocks and says
which.
"""

import argparse
import ctypes
import json
import os
import statistics
import subprocess
import sys
import threading
import time
from ctypes import wintypes
from pathlib import Path

import bench
import state

HERE = Path(__file__).resolve().parent
NCPU = os.cpu_count() or 1
# Thresholds of a noisy block. Other processes' CPU is compared with the cell's own median, not with zero: on this
# laptop a few processes run all night (Defender, an animated wallpaper, the agents' terminals), and a constant
# background cancels between neighbouring blocks; what does not cancel is a change of it within the cell. 2 % of
# 16 logical processors is a third of a core, which at the measured ~1-2 W per busy core is ~0.5 W, the size of
# the differences the floor looks for. Any other process's Arc 3D/Compute share above 3 points is flagged outright:
# a GPU waking for someone else moves the package by watts.
OTHER_CPU_DEVIATION_PCT = 2.0
OTHER_GPU_PCT = 3.0
BIN_S = 10.0


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD),
                ("cntThreads", wintypes.DWORD), ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260)]


def descendants(root: int) -> set[int]:
    """The processes below `root` now. A venv's python.exe is a launcher that runs the base interpreter as its
    child, so a step's real work (and the Whisper meeting's probe) runs in descendants of the step's process."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    parents: dict[int, int] = {}
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    try:
        ok = kernel32.Process32First(snapshot, ctypes.byref(entry))
        while ok:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            ok = kernel32.Process32Next(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    found, frontier = set(), {root}
    while frontier:
        frontier = {pid for pid, parent in parents.items() if parent in frontier and pid not in found} - {root}
        found |= frontier
    return found


def watch_descendants(process: subprocess.Popen, found: set[int]) -> None:
    """Adds the process's descendants to `found` once a second until it exits."""
    while process.poll() is None:
        found |= descendants(process.pid)
        time.sleep(1.0)


def run_cell(out: Path, spec: dict) -> None:
    out.mkdir(parents=True, exist_ok=True)
    stop = out / "stop"
    stop.unlink(missing_ok=True)
    marks = out / "marks.jsonl"
    marks.unlink(missing_ok=True)
    sampler = subprocess.Popen([sys.executable, str(HERE / "sampler.py"), str(out / "samples.jsonl"), str(stop)],
                               cwd=HERE)
    cell = {"spec": spec, "driver_pid": os.getpid(), "sampler_pid": sampler.pid, "state_start": state.read(),
            "steps": [], "load": None}
    time.sleep(2.0)
    # The sampler started through a venv launcher samples in the launcher's child.
    cell["sampler_child_pids"] = sorted(descendants(sampler.pid))
    env = dict(os.environ, BENCH_MARKS=str(marks), PYTHONUNBUFFERED="1", **spec.get("env", {}))
    load = None

    def stop_load() -> None:
        if load is not None and load.poll() is None:
            load.terminate()
            try:
                load.wait(timeout=10)
            except subprocess.TimeoutExpired:
                load.kill()
            cell["load"]["t1"] = time.time()

    try:
        for i, step in enumerate(spec["steps"]):
            record = {"name": step.get("name", step["kind"]), "kind": step["kind"], "state": state.read()}
            print(f"cells: {time.strftime('%H:%M:%S')} step {i} {record['name']} ({step['kind']})", flush=True)
            if step["kind"] == "load-start":
                load_log = (out / "load.log").open("w", encoding="utf-8")
                load = subprocess.Popen(spec["load"], stdout=load_log, stderr=subprocess.STDOUT, env=env)
                cell["load"] = {"cmd": spec["load"], "pid": load.pid, "t0": time.time()}
                record.update(t0=time.time(), t1=time.time())
            elif step["kind"] == "load-stop":
                stop_load()
                record.update(t0=time.time(), t1=time.time())
            elif step["kind"] == "idle":
                time.sleep(step.get("settle", 0))
                t0 = time.time()
                time.sleep(step["seconds"])
                record.update(t0=t0, t1=time.time())
                with marks.open("a", encoding="utf-8") as file:
                    file.write(json.dumps({"phase": step.get("phase", "idle"), "t0": t0, "t1": record["t1"],
                                           "step": i}) + "\n")
            else:
                step_env = dict(env, BENCH_STEP=str(i), **step.get("env", {}))
                started = time.time()
                with (out / f"step-{i}-{step['name']}.log").open("w", encoding="utf-8") as log:
                    process = subprocess.Popen(step["cmd"], stdout=log, stderr=subprocess.STDOUT, env=step_env,
                                               cwd=step.get("cwd"))
                    record["pid"] = process.pid
                    children: set[int] = set()
                    watcher = threading.Thread(target=watch_descendants, args=(process, children), daemon=True)
                    watcher.start()
                    code = process.wait()
                    watcher.join(timeout=5)
                record.update(t0=started, t1=time.time(), exit_code=code, child_pids=sorted(children))
                if code != 0:
                    print(f"cells: step {i} exited {code}", file=sys.stderr, flush=True)
            cell["steps"].append(record)
            (out / "cell.json").write_text(json.dumps(cell, indent=1, ensure_ascii=False), encoding="utf-8")
    finally:
        stop_load()
        cell["state_end"] = state.read()
        time.sleep(2.0)
        stop.touch()
        sampler.wait(timeout=30)
        (out / "cell.json").write_text(json.dumps(cell, indent=1, ensure_ascii=False), encoding="utf-8")


def step_of(cell: dict, t0: float, t1: float) -> int | None:
    for i, step in enumerate(cell["steps"]):
        if step["kind"] == "cmd" and step["t0"] - 1.0 <= t0 and t1 <= step["t1"] + 1.0:
            return i
    return None


def background(rows: list[dict], own: set[str]) -> dict:
    """Other processes' CPU and GPU over the rows; `own` are the pids of the cell's own processes."""
    if not rows:
        return {}
    other_cpu, own_cpu, other_gpu, per = [], [], [], {}
    for row in rows:
        procs = row.get("procs", {})
        mine = sum(v for k, v in procs.items() if k.rsplit(":", 1)[1] in own)
        own_cpu.append(mine / NCPU)
        if row.get("busy") == row.get("busy"):  # NaN now and then
            other_cpu.append(max(row.get("busy", 0.0) - mine / NCPU, 0.0))
        for k, v in procs.items():
            if k.rsplit(":", 1)[1] not in own:
                per[k] = per.get(k, 0.0) + v / NCPU
        gpu = sum(v for pid, engines in row.get("gpu_pids", {}).items() if pid not in own
                  for key, v in engines.items() if key in ("arc.3D", "arc.Compute"))
        other_gpu.append(gpu)
    top = sorted(per.items(), key=lambda kv: -kv[1])[:5]
    cstate = {key: round(statistics.mean(r["cstate"][key] for r in rows if key in r.get("cstate", {})), 2)
              for key in ("c1", "c2", "c3", "irq_s", "csw_s") if any(key in r.get("cstate", {}) for r in rows)}
    zones = [v for r in rows for v in r.get("tz", {}).values()]
    return {"other_cpu_pct": round(statistics.mean(other_cpu), 2) if other_cpu else None,
            "own_cpu_pct": round(statistics.mean(own_cpu), 2),
            "other_gpu_pct": round(statistics.mean(other_gpu), 2), "other_gpu_max": round(max(other_gpu), 1),
            "top_other": [(k, round(v / len(rows), 2)) for k, v in top], "cstate": cstate,
            "tz_k": round(statistics.mean(zones), 1) if zones else None}


def binned_median(samples: bench.Samples, t0: float, t1: float, rail: str = "PKG") -> float | None:
    bins = int((t1 - t0) // BIN_S)
    if bins < 3:
        return None
    return round(statistics.median(samples.joules(t0 + i * BIN_S, t0 + (i + 1) * BIN_S)[rail] / BIN_S
                                   for i in range(bins)), 3)


def analyse(out: Path) -> dict:
    samples = bench.Samples(out / "samples.jsonl")
    cell = json.loads((out / "cell.json").read_text(encoding="utf-8"))
    own = {str(cell["driver_pid"]), str(cell["sampler_pid"])}
    own |= {str(s["pid"]) for s in cell["steps"] if "pid" in s}
    own |= {str(pid) for s in cell["steps"] for pid in s.get("child_pids", [])}
    own |= {str(pid) for pid in cell.get("sampler_child_pids", [])}
    if cell.get("load"):
        own.add(str(cell["load"]["pid"]))
    marks = [json.loads(line) for line in (out / "marks.jsonl").read_text(encoding="utf-8").splitlines()
             if line.strip()]
    # A workload's helper processes (the Whisper meeting's Nemotron probe) are the cell's own too.
    own |= {str(pid) for mark in marks for pid in mark.get("child_pids", [])}
    rows_all = samples.usage
    blocks = []
    for mark in marks:
        t0, t1 = mark["t0"], mark["t1"]
        seconds = t1 - t0
        joules = samples.joules(t0, t1)
        watts = {k: round(v / seconds, 3) for k, v in joules.items()}
        watts["rest"] = round(watts["PKG"] - watts["PP0"] - watts["PP1"], 3)
        rows = [r for r in rows_all if t0 <= r["t"] <= t1]
        step = mark.get("step", step_of(cell, t0, t1))
        entry = {key: value for key, value in mark.items() if key not in ("t0", "t1")}
        entry.update(step=step, step_name=cell["steps"][step]["name"] if step is not None else None,
                     t0=t0, t1=t1, seconds=round(seconds, 1), watts=watts,
                     pkg_median_10s=binned_median(samples, t0, t1),
                     utilization=samples.utilization(t0, t1), background=background(rows, own))
        if step is not None:
            entry["display"] = cell["steps"][step]["state"]["display"]
        blocks.append(entry)
    measured = [b for b in blocks if b["phase"] in ("idle", "resident", "meeting", "load-alone", "paced")]
    others = [b["background"]["other_cpu_pct"] for b in measured if b["background"].get("other_cpu_pct") is not None]
    median_other = statistics.median(others) if others else 0.0
    for b in measured:
        reasons = []
        bg = b["background"]
        if bg.get("other_cpu_pct") is not None and abs(bg["other_cpu_pct"] - median_other) > OTHER_CPU_DEVIATION_PCT:
            reasons.append(f"other CPU {bg['other_cpu_pct']} % vs cell median {median_other:.2f} %")
        if bg.get("other_gpu_pct", 0) > OTHER_GPU_PCT:
            reasons.append(f"other Arc 3D/Compute {bg['other_gpu_pct']} %")
        b["flagged"] = reasons
    result = {"state_start": cell["state_start"], "state_end": cell.get("state_end"),
              "other_cpu_median_pct": round(median_other, 2), "blocks": blocks}
    (out / "cell-power.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    return result


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--spec", type=Path)
    parser.add_argument("--analyse", action="store_true")
    args = parser.parse_args()
    args.out = args.out.resolve()
    if not args.analyse:
        run_cell(args.out, json.loads(args.spec.read_text(encoding="utf-8")))
    result = analyse(args.out)
    for b in result["blocks"]:
        bg = b["background"]
        print(f"{b['step']!s:>3} {b['step_name'] or '':<10} {b['phase']:<16} {b['seconds']:>7.1f} s  "
              f"PKG {b['watts']['PKG']:>6.2f} W (med {b['pkg_median_10s']})  PP0 {b['watts']['PP0']:.2f}  "
              f"PP1 {b['watts']['PP1']:.2f}  rest {b['watts']['rest']:.2f}  other CPU {bg.get('other_cpu_pct')} %  "
              f"GPU {bg.get('other_gpu_pct')} %  {' FLAG ' + '; '.join(b['flagged']) if b.get('flagged') else ''}")


if __name__ == "__main__":
    main()
