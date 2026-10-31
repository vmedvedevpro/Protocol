"""Windows performance counters through PDH (ctypes, no admin): RAPL energy and GPU/NPU engine utilization.

The `Energy Meter` counter set reports RAPL without admin rights. Its `Energy` counter is cumulative in
picowatt-hours (measured on this laptop: 1.4826e9 units/s while the `Power` counter showed 5337 mW, and
3.6e-9 J * 1.4826e9 = 5.337 J/s), and `Power` is in milliwatts. Energy over a window is therefore the difference
of two raw `Energy` readings, exact whatever the sampling rate, instead of an average of 1 Hz power samples.

The NPU is an MCDM compute-only adapter: Windows lists it under `GPU Engine` like a GPU, as an adapter whose only
engine type is `Neural` (measured with driver 32.0.100.5540; its instances exist only while a process holds the NPU
open). The Arc iGPU is the adapter that also has `VideoDecode`/`GSC` engines.
"""

import ctypes
import re
from ctypes import wintypes

PWH_TO_J = 3.6e-9
RAILS = ("PKG", "PP0", "PP1", "DRAM")

_pdh = ctypes.WinDLL("pdh.dll")

PDH_FMT_DOUBLE = 0x00000200
PDH_FMT_NOCAP100 = 0x00008000
PDH_MORE_DATA = 0x800007D2


class PDH_RAW_COUNTER(ctypes.Structure):
    _fields_ = [("CStatus", wintypes.DWORD), ("TimeStamp", wintypes.FILETIME), ("FirstValue", ctypes.c_longlong),
                ("SecondValue", ctypes.c_longlong), ("MultiCount", wintypes.DWORD)]


class PDH_FMT_COUNTERVALUE(ctypes.Structure):
    _fields_ = [("CStatus", wintypes.DWORD), ("doubleValue", ctypes.c_double)]


class PDH_FMT_COUNTERVALUE_ITEM_W(ctypes.Structure):
    _fields_ = [("szName", wintypes.LPWSTR), ("FmtValue", PDH_FMT_COUNTERVALUE)]


def _check(status: int, what: str) -> None:
    if status != 0:
        raise OSError(f"{what}: PDH status 0x{status & 0xFFFFFFFF:08X}")


class Query:
    def __init__(self) -> None:
        self.handle = wintypes.HANDLE()
        _check(_pdh.PdhOpenQueryW(None, None, ctypes.byref(self.handle)), "PdhOpenQuery")

    def add(self, path: str) -> wintypes.HANDLE:
        counter = wintypes.HANDLE()
        _check(_pdh.PdhAddEnglishCounterW(self.handle, path, None, ctypes.byref(counter)), f"add {path}")
        return counter

    def collect(self) -> None:
        _check(_pdh.PdhCollectQueryData(self.handle), "PdhCollectQueryData")

    def close(self) -> None:
        _pdh.PdhCloseQuery(self.handle)


def raw(counter: wintypes.HANDLE) -> int:
    value = PDH_RAW_COUNTER()
    ctype = wintypes.DWORD()
    _check(_pdh.PdhGetRawCounterValue(counter, ctypes.byref(ctype), ctypes.byref(value)), "PdhGetRawCounterValue")
    return value.FirstValue


def formatted(counter: wintypes.HANDLE) -> float:
    value = PDH_FMT_COUNTERVALUE()
    status = _pdh.PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, None, ctypes.byref(value))
    return value.doubleValue if status == 0 else float("nan")


def formatted_array(counter: wintypes.HANDLE) -> dict[str, float]:
    size = wintypes.DWORD(0)
    count = wintypes.DWORD(0)
    status = _pdh.PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ctypes.byref(size),
                                               ctypes.byref(count), None)
    if status & 0xFFFFFFFF != PDH_MORE_DATA:
        return {}
    buffer = ctypes.create_string_buffer(size.value)
    status = _pdh.PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE | PDH_FMT_NOCAP100, ctypes.byref(size),
                                               ctypes.byref(count), buffer)
    if status != 0:
        return {}
    items = ctypes.cast(buffer, ctypes.POINTER(PDH_FMT_COUNTERVALUE_ITEM_W))
    return {items[i].szName: items[i].FmtValue.doubleValue for i in range(count.value) if items[i].FmtValue.CStatus in (0, 1)}


_ENGINE = re.compile(r"pid_(\d+)_luid_(0x\w+_0x\w+)_phys_\d+_eng_(\d+)_engtype_(\w+)")


def engines(utilization: dict[str, float]) -> dict[tuple[str, str], float]:
    """Utilization per (adapter LUID, engine type): the per-process instances of one engine summed (they share
    it), then the busiest engine of the type (an adapter has many 3D/Copy engines; summing them would exceed
    100 %)."""
    per_engine: dict[tuple[str, str, str], float] = {}
    for name, value in utilization.items():
        match = _ENGINE.search(name)
        # An instance created between two collections can read as a huge number; one instance is at most 100 %.
        if match and 0.0 <= value <= 100.0:
            key = (match.group(2), match.group(4), match.group(3))
            per_engine[key] = per_engine.get(key, 0.0) + value
    result: dict[tuple[str, str], float] = {}
    for (luid, engtype, _), value in per_engine.items():
        result[(luid, engtype)] = max(result.get((luid, engtype), 0.0), value)
    return result


def pids(utilization: dict[str, float], names: dict[str, str]) -> dict[str, float]:
    """The NPU's utilization per process id, for the processes with a non-zero share."""
    result: dict[str, float] = {}
    for name, value in utilization.items():
        match = _ENGINE.search(name)
        if match and names.get(match.group(2)) == "npu" and value > 0:
            result[match.group(1)] = round(result.get(match.group(1), 0.0) + value, 2)
    return result


def engine_pids(utilization: dict[str, float], names: dict[str, str]) -> dict[str, dict[str, float]]:
    """Each process's utilization of the Arc's and the NPU's engines, `pid` to `adapter.engtype` to %, for the
    non-zero shares: who else used the GPU during a measurement (#80)."""
    result: dict[str, dict[str, float]] = {}
    for name, value in utilization.items():
        match = _ENGINE.search(name)
        if match and 0.05 < value <= 100.0 and match.group(2) in names:
            key = f"{names[match.group(2)]}.{match.group(4)}"
            per = result.setdefault(match.group(1), {})
            per[key] = round(per.get(key, 0.0) + value, 2)
    return result


def processes(cpu: dict[str, float], ids: dict[str, float], floor: float = 0.5) -> dict[str, float]:
    """`name:pid` to % of one core for the processes above `floor` %, from the `Process` counter set's instance
    arrays (instances of one name are `name`, `name#1`, ...; the pid tells them apart). `Idle` and `_Total` are
    left out."""
    result = {}
    for instance, value in cpu.items():
        base = instance.split("#")[0]
        if base in ("Idle", "_Total") or not value > floor:
            continue
        result[f"{base}:{int(ids.get(instance, 0))}"] = round(value, 1)
    return result


def adapters(names: list[str]) -> dict[str, str]:
    """`npu` and `arc` LUIDs from the engine instance names: the NPU is the adapter with only Neural (or
    Compute) engines; the Arc iGPU the one with a VideoDecode engine."""
    types: dict[str, set[str]] = {}
    for name in names:
        match = _ENGINE.search(name)
        if match:
            types.setdefault(match.group(2), set()).add(match.group(4))
    found = {}
    for luid, engtypes in types.items():
        if engtypes <= {"Neural", "Compute"}:
            found["npu"] = luid
        elif "VideoDecode" in engtypes:
            found["arc"] = luid
    return found


class Energy:
    """Raw cumulative RAPL energy per rail, read on demand (a PDH collect is about a millisecond)."""

    def __init__(self) -> None:
        self.query = Query()
        self.counters = {rail: self.query.add(f"\\Energy Meter(RAPL_Package0_{rail})\\Energy") for rail in RAILS}

    def read(self) -> dict[str, int]:
        self.query.collect()
        return {rail: raw(counter) for rail, counter in self.counters.items()}


def joules(start: dict[str, int], end: dict[str, int]) -> dict[str, float]:
    return {rail: (end[rail] - start[rail]) * PWH_TO_J for rail in start}
