"""Samples RAPL energy (10 Hz) and CPU and GPU/NPU engine utilization (1 Hz) into a JSON-lines file.

    python sampler.py OUT.jsonl STOPFILE

Runs as its own process beside a benchmark (so its own work is in the idle baseline too, and cancels out of the
"above idle" numbers) until STOPFILE exists. Lines:

- `{"t", "e"}` ten times a second: wall time and the raw cumulative energy per rail (pWh). Energy over a window is
  the difference at its edges, interpolated between two readings 0.1 s apart.
- `{"t", "cpu", "eng", "npu_pids", ...}` once a second: CPU utility in %, the busiest engine's utilization per
  (adapter, engine type), and which processes use the NPU's engine; and the background (#80): total CPU busy
  (`busy`, % of all cores), each process above 0.5 % of one core (`procs`, `name:pid` to % of one core), each
  process's share of the Arc's and the NPU's engines (`gpu_pids`), the cores' C-state residency and the interrupt
  and context-switch rates (`cstate`), and, every ten seconds, the ACPI thermal zones in kelvin (`tz`).

The NPU's `GPU Engine` instances exist only while a process holds the NPU open, so the adapters are recognised
again at every sample (`pdh.adapters`) instead of once at the start.
"""

import json
import sys
import time
from pathlib import Path

import pdh

ENERGY_PERIOD_S = 0.1
ENGINE_EVERY = 10


def main() -> None:
    out, stop = Path(sys.argv[1]), Path(sys.argv[2])
    energy_query = pdh.Query()
    energy = {rail: energy_query.add(f"\\Energy Meter(RAPL_Package0_{rail})\\Energy") for rail in pdh.RAILS}
    usage_query = pdh.Query()
    cpu = usage_query.add(r"\Processor Information(_Total)\% Processor Utility")
    gpu = usage_query.add(r"\GPU Engine(*)\Utilization Percentage")
    noise_query = pdh.Query()
    busy = noise_query.add(r"\Processor Information(_Total)\% Processor Time")
    proc_cpu = noise_query.add(r"\Process(*)\% Processor Time")
    proc_id = noise_query.add(r"\Process(*)\ID Process")
    cstates = {name: noise_query.add(rf"\Processor Information(_Total)\{counter}") for name, counter in
               (("c1", "% C1 Time"), ("c2", "% C2 Time"), ("c3", "% C3 Time"), ("irq_s", "Interrupts/sec"))}
    cstates["csw_s"] = noise_query.add(r"\System\Context Switches/sec")
    thermal = noise_query.add(r"\Thermal Zone Information(*)\High Precision Temperature")
    usage_query.collect()
    noise_query.collect()
    names: dict[str, str] = {}
    with out.open("w", encoding="utf-8") as file:
        tick = 0
        next_at = time.monotonic()
        while not stop.exists():
            next_at += ENERGY_PERIOD_S
            time.sleep(max(0.0, next_at - time.monotonic()))
            energy_query.collect()
            file.write(json.dumps({"t": time.time(), "e": {rail: pdh.raw(c) for rail, c in energy.items()}}) + "\n")
            tick += 1
            if tick % ENGINE_EVERY:
                continue
            usage_query.collect()
            utilization = pdh.formatted_array(gpu)
            for name, luid in pdh.adapters(list(utilization)).items():
                names.setdefault(luid, name)
            engines = pdh.engines(utilization)
            noise_query.collect()
            row = {"t": time.time(), "cpu": round(pdh.formatted(cpu), 2),
                   "eng": {f"{names.get(luid, luid)}.{engtype}": round(value, 2)
                           for (luid, engtype), value in engines.items()},
                   "npu_pids": pdh.pids(utilization, names),
                   "busy": round(pdh.formatted(busy), 2),
                   "procs": pdh.processes(pdh.formatted_array(proc_cpu), pdh.formatted_array(proc_id)),
                   "gpu_pids": pdh.engine_pids(utilization, names),
                   "cstate": {name: round(pdh.formatted(c), 2) for name, c in cstates.items()}}
            if tick % (10 * ENGINE_EVERY) == 0:
                row["tz"] = {zone: round(value / 10.0, 1) for zone, value in pdh.formatted_array(thermal).items()}
            file.write(json.dumps(row) + "\n")
            file.flush()
    energy_query.close()
    usage_query.close()
    noise_query.close()


if __name__ == "__main__":
    main()
