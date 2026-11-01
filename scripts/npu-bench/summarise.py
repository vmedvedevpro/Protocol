"""Summaries across `cells.py` cells (#80).

    python summarise.py floor DIR...      (resident floor: each device's block against its idle neighbours)
    python summarise.py meeting DIR...    (simulated meetings: power above the idle blocks around them)
    python summarise.py batch DIR...      (batch repeats: J above idle per audio minute, x real time)
    python summarise.py r2-meeting DIR... (round 2: NPU - GPU per model, pass by pass, pooled over the ABBA cells)
    python summarise.py r2-paced DIR...   (round 2: J per call against the pauses and W above idle, per device)
    python summarise.py r2-floor DIR...   (round 2: Whisper resident on GPU and NPU against idle)
    python summarise.py r2-batch DIR...   (round 2: batch runs per model, feed and device, NPU - GPU)
    python summarise.py r2-starts DIR...  (round 2: first start into an empty cache)

Floor. Every resident block sits between two no-model idle blocks of the same cell; its difference is its power
minus the mean of those two, so a drift that is linear over the ~7 minutes of the three blocks cancels. The
differences of one device across cells are independent draws of its floor; the summary gives their mean, standard
deviation and a 95 % confidence interval from Student's t. Flagged blocks (a noisy background, `cells.py`) are
left out, and so is any difference whose idle neighbour is flagged; the summary lists them.

Meeting. The meeting's power minus the mean of the idle blocks before and after it, per rail, and the joules
above idle per minute of audio; the calls' latency and lag come from the probe's own JSON (`PACED_OUT`). The
meeting loops its audio, so each pass over it is the same work (the same turns, the same diarization): the
meeting is also cut into whole passes, and the power of each pass is a repeat for a confidence interval and for
comparing devices (Welch), free of the idle blocks, which a single background process can move by a watt.

Round 2 names its steps `<model>-<device>` (`wh-gpu`, `pk-npu`) and its batch runs `<model>-<feed>-<device>-<n>`;
every comparison is NPU - GPU of one model (and feed), with a 95 % interval from Welch's t. Paced blocks are read
twice: against their own pauses (each 6 s period's energy minus its last 2 s's power times the period, #66), which
gives one value per call, and against the mean of the idle blocks on both sides.
"""

import json
import math
import statistics
import sys
import wave
from pathlib import Path

import bench

# Two-sided 95 % Student's t by degrees of freedom.
T95 = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36, 8: 2.31, 9: 2.26, 10: 2.23, 11: 2.20,
       12: 2.18, 15: 2.13, 20: 2.09, 30: 2.04}
RAILS = ("PKG", "PP0", "PP1", "DRAM", "rest")


def t95(df: int) -> float:
    return T95.get(df) or T95[max(k for k in T95 if k <= df)] if df > 0 else float("nan")


def stats(values: list[float]) -> dict:
    n = len(values)
    if not n:
        return {"n": 0}
    mean = statistics.mean(values)
    sd = statistics.stdev(values) if n > 1 else float("nan")
    half = t95(n - 1) * sd / math.sqrt(n) if n > 1 else float("nan")
    return {"n": n, "mean": round(mean, 3), "sd": round(sd, 3), "ci95": [round(mean - half, 3), round(mean + half, 3)],
            "values": [round(v, 3) for v in values]}


def welch(a: list[float], b: list[float]) -> dict:
    """mean(a) - mean(b) with a 95 % interval from Welch's t (Welch-Satterthwaite degrees of freedom)."""
    va, vb = statistics.variance(a) / len(a), statistics.variance(b) / len(b)
    df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1)) if va + vb else 1
    diff = statistics.mean(a) - statistics.mean(b)
    half = t95(int(df)) * math.sqrt(va + vb)
    return {"diff": round(diff, 3), "ci95": [round(diff - half, 3), round(diff + half, 3)], "df": round(df, 1)}


def passes(cell: Path, block: dict) -> list[dict]:
    """Power per rail over each whole pass of the looped audio within the meeting block."""
    spec = json.loads((cell / "cell-spec.json").read_text(encoding="utf-8"))
    step = spec["steps"][block["step"]]
    with wave.open(step["env"]["MEASURE_AUDIO"]) as w:
        length = w.getnframes() / w.getframerate()
    samples = bench.Samples(cell / "samples.jsonl")
    out, start = [], block["t0"]
    while start + length <= block["t1"] + 1.0:
        joules = samples.joules(start, start + length)
        watts = {rail: joules[rail] / length for rail in ("PKG", "PP0", "PP1", "DRAM")}
        watts["rest"] = watts["PKG"] - watts["PP0"] - watts["PP1"]
        out.append({rail: round(v, 3) for rail, v in watts.items()})
        start += length
    return out


def blocks(cell: Path) -> list[dict]:
    data = json.loads((cell / "cell-power.json").read_text(encoding="utf-8"))
    return [b for b in data["blocks"] if b["phase"] in ("idle", "resident", "meeting", "load-alone")]


def floor(cells: list[Path]) -> dict:
    per: dict[str, dict[str, list[float]]] = {}
    dropped = []
    noise = []
    for cell in cells:
        seq = blocks(cell)
        for i, b in enumerate(seq):
            noise.append({"cell": cell.name, "step": b["step"], "phase": b["phase"], "flagged": b["flagged"],
                          "other_cpu_pct": b["background"].get("other_cpu_pct"),
                          "other_gpu_pct": b["background"].get("other_gpu_pct")})
            if b["phase"] != "resident":
                continue
            before = next((x for x in reversed(seq[:i]) if x["phase"] == "idle"), None)
            after = next((x for x in seq[i + 1:] if x["phase"] == "idle"), None)
            device = b["step_name"]
            if before is None or after is None:
                dropped.append(f"{cell.name} step {b['step']} {device}: no idle neighbour")
                continue
            bad = [x for x in (b, before, after) if x["flagged"]]
            if bad:
                dropped.append(f"{cell.name} step {b['step']} {device}: flagged "
                               f"{[(x['step'], x['flagged']) for x in bad]}")
                continue
            for rail in RAILS:
                diff = b["watts"][rail] - (before["watts"][rail] + after["watts"][rail]) / 2
                per.setdefault(device, {}).setdefault(rail, []).append(diff)
            idle = (before["watts"]["PKG"] + after["watts"]["PKG"]) / 2
            per[device].setdefault("idle_pkg", []).append(idle)
            if b["pkg_median_10s"] is not None and before["pkg_median_10s"] is not None and after["pkg_median_10s"] is not None:
                per[device].setdefault("PKG_median10s", []).append(
                    b["pkg_median_10s"] - (before["pkg_median_10s"] + after["pkg_median_10s"]) / 2)
            util = b["utilization"].get("mean_pct", {})
            per[device].setdefault("cpu_util", []).append(util.get("cpu") or 0.0)
            per[device].setdefault("own_cpu_pct", []).append(b["background"].get("own_cpu_pct") or 0.0)
            for key in ("c1", "c3", "irq_s", "csw_s"):
                mine, ref = b["background"]["cstate"].get(key), [x["background"]["cstate"].get(key) for x in (before, after)]
                if mine is not None and None not in ref:
                    per[device].setdefault(f"d_{key}", []).append(mine - sum(ref) / 2)
    idle_all = [b["watts"]["PKG"] for cell in cells for b in blocks(cell) if b["phase"] == "idle" and not b["flagged"]]
    return {"devices": {d: {k: stats(v) for k, v in rails.items()} for d, rails in per.items()},
            "idle_pkg": stats(idle_all), "dropped": dropped, "noise": noise}


def meeting(cells: list[Path]) -> dict:
    out = []
    for cell in cells:
        seq = blocks(cell)
        for i, b in enumerate(seq):
            if b["phase"] != "meeting":
                continue
            before = next((x for x in reversed(seq[:i]) if x["phase"] in ("idle", "load-alone")), None)
            after = next((x for x in seq[i + 1:] if x["phase"] in ("idle", "load-alone")), None)
            ref = [x for x in (before, after) if x is not None]
            if not ref:
                continue
            above = {rail: round(b["watts"][rail] - statistics.mean(x["watts"][rail] for x in ref), 3) for rail in RAILS}
            audio_min = b.get("audio_s", b["seconds"]) / 60.0
            out.append({"cell": cell.name, "step_name": b["step_name"], "device": b.get("device"),
                        "acceleration": b.get("acceleration"), "seconds": b["seconds"],
                        "idle_pkg": [round(x["watts"]["PKG"], 3) for x in ref], "watts": b["watts"],
                        "above_idle_w": above,
                        "j_above_idle_per_audio_min": round(above["PKG"] * b["seconds"] / audio_min, 2),
                        "calls": b.get("calls"), "late_calls": b.get("late_calls"), "max_lag_s": b.get("max_lag_s"),
                        "latency_ms": [b.get("latency_ms_median"), b.get("latency_ms_p95"), b.get("latency_ms_max")],
                        "busy_share": b.get("busy_share"), "labelled": b.get("labelled"),
                        "utilization": b["utilization"].get("mean_pct"),
                        "flagged": b["flagged"] + [f"neighbour {x['step']}: {x['flagged']}" for x in ref if x["flagged"]],
                        "background": {k: b["background"].get(k) for k in ("other_cpu_pct", "other_gpu_pct", "top_other")},
                        "passes": {rail: stats([x[rail] for x in passes(cell, b)]) for rail in RAILS}})
    by_device: dict[str, list[dict]] = {}
    for m in out:
        by_device.setdefault(m["step_name"], []).append(m)
    compare = {}
    if "npu" in by_device:
        base = {rail: [v for m in by_device["npu"] for v in m["passes"][rail]["values"]] for rail in RAILS}
        for device, ms in by_device.items():
            if device != "npu":
                compare[f"{device} - npu"] = {rail: welch([v for m in ms for v in m["passes"][rail]["values"]],
                                                          base[rail]) for rail in RAILS}
    return {"meetings": out, "per_pass_vs_npu": compare}


def batch(cells: list[Path]) -> dict:
    """Per run of a batch cell: the timed repeat's power above the idle blocks around its process, J above idle
    per audio minute, × real time, and the load (warm from the caches, or the cold compile)."""
    runs = []
    for cell in cells:
        data = json.loads((cell / "cell-power.json").read_text(encoding="utf-8"))
        seq = data["blocks"]
        for i, b in enumerate(seq):
            if not b["phase"].startswith("rep"):
                continue
            before = next((x for x in reversed(seq[:i]) if x["phase"] == "idle"), None)
            after = next((x for x in seq[i + 1:] if x["phase"] == "idle"), None)
            ref = [x for x in (before, after) if x is not None]
            idle_w = {rail: statistics.mean(x["watts"][rail] for x in ref) for rail in RAILS}
            load = next((x for x in seq if x["phase"] == "load" and x["step"] == b["step"]), None)
            above = {rail: round(b["watts"][rail] - idle_w[rail], 2) for rail in RAILS}
            runs.append({"cell": cell.name, "run": b["step_name"], "seconds": b["seconds"],
                         "x_realtime": round(b["audio_s"] / b["seconds"], 2), "above_idle_w": above,
                         "j_per_audio_min": round(above["PKG"] * b["seconds"] / (b["audio_s"] / 60.0), 2),
                         "load_s": load["seconds"] if load else None,
                         "cache_bytes_before": load.get("cache_bytes_before") if load else None,
                         "utilization": b["utilization"].get("mean_pct"),
                         "flagged": [f"neighbour {x['step']}: {x['flagged']}" for x in ref if x.get("flagged")]})
    by_device: dict[str, dict[str, list[float]]] = {}
    for run in runs:
        device = run["run"].rsplit("-", 1)[0]
        if run["run"].startswith(("cold", "compile")):
            continue
        for key in ("x_realtime", "j_per_audio_min", "load_s"):
            by_device.setdefault(device, {}).setdefault(key, []).append(run[key])
        by_device[device].setdefault("above_pkg_w", []).append(run["above_idle_w"]["PKG"])
    return {"runs": runs, "devices": {d: {k: stats([v for v in vals if v is not None]) for k, vals in keys.items()}
                                      for d, keys in by_device.items()}}


def split_name(name: str) -> tuple[str, str]:
    """`wh-gpu` -> (`wh`, `gpu`); `wh-live-gpu-3` -> (`wh-live`, `gpu`)."""
    parts = name.split("-")
    if parts[-1].isdigit():
        parts = parts[:-1]
    return "-".join(parts[:-1]), parts[-1]


def neighbours(seq: list[dict], i: int, phases=("idle",)) -> list[dict]:
    before = next((x for x in reversed(seq[:i]) if x["phase"] in phases), None)
    after = next((x for x in seq[i + 1:] if x["phase"] in phases), None)
    return [x for x in (before, after) if x is not None]


def npu_minus_gpu(per: dict[str, dict[str, list[float]]], keys) -> dict:
    out = {}
    for key in keys:
        gpu, npu = per.get("gpu", {}).get(key, []), per.get("npu", {}).get(key, [])
        if len(gpu) > 1 and len(npu) > 1:
            out[key] = welch(npu, gpu)
    return out


def r2_meeting(cells: list[Path]) -> dict:
    """Each meeting block cut into whole passes over the looped audio; per model the passes of each device pooled
    over the cells (GPU NPU, NPU GPU) and NPU - GPU per rail. Above idle: the block minus the mean of its two idle
    neighbours, for reference."""
    rows, per = [], {}
    for cell in cells:
        seq = blocks(cell)
        for i, b in enumerate(seq):
            if b["phase"] != "meeting":
                continue
            model, device = split_name(b["step_name"])
            ref = neighbours(seq, i)
            values = passes(cell, b)
            for rail in RAILS:
                per.setdefault(model, {}).setdefault(device, {}).setdefault(rail, []).extend(v[rail] for v in values)
            rows.append({"cell": cell.name, "step": b["step"], "name": b["step_name"], "seconds": b["seconds"],
                         "watts": b["watts"], "passes": len(values),
                         "pass_pkg": [v["PKG"] for v in values],
                         "above_idle_w": {r: round(b["watts"][r] - statistics.mean(x["watts"][r] for x in ref), 3)
                                          for r in RAILS} if ref else None,
                         "idle_pkg": [x["watts"]["PKG"] for x in ref],
                         "calls": b.get("calls"), "late_calls": b.get("late_calls"), "max_lag_s": b.get("max_lag_s"),
                         "latency_ms": [b.get("latency_ms_median"), b.get("latency_ms_p95"), b.get("latency_ms_max")],
                         "busy_share": b.get("busy_share"), "labelled": b.get("labelled"),
                         "diarization_failures": b.get("diarization_failures"),
                         "utilization": b["utilization"].get("mean_pct"), "display": b.get("display"),
                         "flagged": b["flagged"] + [f"neighbour {x['step']}: {x['flagged']}" for x in ref
                                                    if x["flagged"]],
                         "background": {k: b["background"].get(k) for k in ("other_cpu_pct", "other_gpu_pct",
                                                                            "top_other")}})
    models = {}
    for model, devices in per.items():
        models[model] = {d: {r: stats(v) for r, v in rails.items()} for d, rails in devices.items()}
        models[model]["npu - gpu"] = npu_minus_gpu(devices, RAILS)
    return {"meetings": rows, "models": models}


def period_increments(samples: bench.Samples, t0: float, period: float, calls: int, gap: float = 2.0) -> list[float]:
    """`bench.paced_increment`'s per-period values: each period's energy minus its last `gap` seconds' power
    times the period (J per call against the pauses)."""
    out = []
    for i in range(calls):
        start, end = t0 + i * period, t0 + (i + 1) * period
        quiet_w = samples.joules(end - gap, end)["PKG"] / gap
        out.append(samples.joules(start, end)["PKG"] - quiet_w * period)
    return out


def r2_paced(cells: list[Path]) -> dict:
    rows, per = [], {}
    for cell in cells:
        samples = bench.Samples(cell / "samples.jsonl")
        data = json.loads((cell / "cell-power.json").read_text(encoding="utf-8"))
        seq = data["blocks"]
        for i, b in enumerate(seq):
            if b["phase"] != "paced":
                continue
            model, device = split_name(b["step_name"])
            ref = neighbours(seq, i)
            increments = period_increments(samples, b["t0"], b["period_s"], int(b["calls"]))
            above = {r: b["watts"][r] - statistics.mean(x["watts"][r] for x in ref) for r in RAILS}
            entry = per.setdefault(model, {}).setdefault(device, {})
            entry.setdefault("j_per_call", []).extend(increments)
            entry.setdefault("w_above_idle", []).append(above["PKG"])
            entry.setdefault("latency_ms", []).extend(b.get("latency_ms", []))
            for r in ("PP0", "PP1", "rest", "DRAM"):
                entry.setdefault(f"w_above_idle_{r}", []).append(above[r])
            rows.append({"cell": cell.name, "step": b["step"], "name": b["step_name"], "calls": b["calls"],
                         "late_calls": b.get("late_calls"), "watts": b["watts"],
                         "w_above_idle": {r: round(v, 3) for r, v in above.items()},
                         "idle_pkg": [x["watts"]["PKG"] for x in ref],
                         "j_per_call_mean": round(statistics.mean(increments), 3),
                         "j_per_call_median": round(statistics.median(increments), 3),
                         "latency_ms": [b.get("latency_ms_median"), b.get("latency_ms_p95"), b.get("latency_ms_max")],
                         "utilization": b["utilization"].get("mean_pct"), "display": b.get("display"),
                         "flagged": b["flagged"] + [f"neighbour {x['step']}: {x['flagged']}" for x in ref
                                                    if x["flagged"]]})
    models = {}
    for model, devices in per.items():
        out = {}
        for device, keys in devices.items():
            lat = sorted(keys["latency_ms"])
            pick = (lambda q: lat[round((len(lat) - 1) * q)]) if lat else (lambda q: None)
            out[device] = {k: stats(v) for k, v in keys.items() if k != "latency_ms"}
            out[device]["w_above_pauses"] = stats([v / 6.0 for v in keys["j_per_call"]])
            out[device]["latency_ms"] = {"median": pick(0.5), "p95": pick(0.95), "max": pick(1.0), "n": len(lat)}
        out["npu - gpu"] = npu_minus_gpu(devices, ("j_per_call", "w_above_idle"))
        models[model] = out
    return {"blocks": rows, "models": models}


def r2_floor(cells: list[Path]) -> dict:
    result = floor(cells)
    devices = {split_name(d)[1]: {r: v["values"] for r, v in rails.items() if "values" in v}
               for d, rails in result["devices"].items()}
    result["npu - gpu"] = npu_minus_gpu(devices, RAILS)
    return result


def r2_batch(cells: list[Path]) -> dict:
    result = batch(cells)
    pairs: dict[str, dict[str, dict[str, list[float]]]] = {}
    for run in result["runs"]:
        feed, device = split_name(run["run"])
        entry = pairs.setdefault(feed, {}).setdefault(device, {})
        for key in ("x_realtime", "j_per_audio_min"):
            entry.setdefault(key, []).append(run[key])
        for rail in RAILS:
            entry.setdefault(f"above_{rail}_w", []).append(run["above_idle_w"][rail])
        entry.setdefault("load_s", []).append(run["load_s"])
    result["feeds"] = {feed: {**{d: {k: stats([v for v in vals if v is not None]) for k, vals in keys.items()}
                                 for d, keys in devices.items()},
                              "npu - gpu": npu_minus_gpu(devices, ("x_realtime", "j_per_audio_min", "above_PKG_w",
                                                                   "above_PP0_w", "above_PP1_w", "above_rest_w"))}
                       for feed, devices in pairs.items()}
    return result


def r2_starts(cells: list[Path]) -> dict:
    out = []
    for cell in cells:
        data = json.loads((cell / "cell-power.json").read_text(encoding="utf-8"))
        for b in data["blocks"]:
            if b["phase"] in ("load", "warmup"):
                out.append({"cell": cell.name, "name": b["step_name"], "phase": b["phase"], "seconds": b["seconds"],
                            "cache_bytes_before": b.get("cache_bytes_before"),
                            "cache_bytes_after": b.get("cache_bytes_after"),
                            "watts_pkg": b["watts"]["PKG"], "utilization": b["utilization"].get("mean_pct")})
    return {"starts": out}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    kind, cells = sys.argv[1], [Path(p) for p in sys.argv[2:]]
    result = {"floor": floor, "meeting": meeting, "batch": batch, "r2-meeting": r2_meeting, "r2-paced": r2_paced,
              "r2-floor": r2_floor, "r2-batch": r2_batch, "r2-starts": r2_starts}[kind](cells)
    print(json.dumps(result if kind == "meeting" else {k: v for k, v in result.items() if k != "noise"},
                     indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
