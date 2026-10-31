"""The machine state a measurement depends on, read without admin (#80): power source, power scheme and its
Windows power-mode overlay, the display's idle timeout against the time since the last input (whether the
display is off), and the drivers' versions are recorded by the caller.

    python state.py            (prints the state as JSON)

The overlay is the Windows 11 power mode laid over the scheme (`PowerGetEffectiveOverlayScheme`); the null GUID
is the default ("balanced") mode. The display state is inferred: Windows turns the display off once the user has
not touched the machine for the scheme's AC display timeout, and nothing tells an unprivileged process that it
did, so "off" means the idle time exceeded the timeout (a program holding the display on would make it wrong;
the overnight keep-awake holds only the system, ES_SYSTEM_REQUIRED).
"""

import ctypes
import json
import time
import uuid
from ctypes import wintypes

OVERLAYS = {
    "00000000-0000-0000-0000-000000000000": "default (balanced)",
    "961cc777-2547-4f9d-8174-7d86181b8a7a": "best power efficiency",
    "ded574b5-45a0-4f42-8737-46345c09c238": "best performance",
}
SUB_VIDEO = uuid.UUID("7516b95f-f776-4464-8c53-06167f40cc99")
VIDEO_IDLE = uuid.UUID("3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e")


class _GUID(ctypes.Structure):
    _fields_ = [("bytes", ctypes.c_ubyte * 16)]

    @classmethod
    def of(cls, value: uuid.UUID) -> "_GUID":
        guid = cls()
        ctypes.memmove(guid.bytes, value.bytes_le, 16)
        return guid


class _PowerStatus(ctypes.Structure):
    _fields_ = [("ac", ctypes.c_ubyte), ("battery_flag", ctypes.c_ubyte), ("percent", ctypes.c_ubyte),
                ("saver", ctypes.c_ubyte), ("life", wintypes.DWORD), ("full_life", wintypes.DWORD)]


class _LastInput(ctypes.Structure):
    _fields_ = [("size", wintypes.UINT), ("time", wintypes.DWORD)]


def read() -> dict:
    powrprof = ctypes.WinDLL("powrprof")
    status = _PowerStatus()
    ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status))
    scheme = ctypes.POINTER(_GUID)()
    powrprof.PowerGetActiveScheme(None, ctypes.byref(scheme))
    name = ctypes.create_string_buffer(512)
    size = wintypes.DWORD(512)
    powrprof.PowerReadFriendlyName(None, scheme, None, None, name, ctypes.byref(size))
    scheme_id = str(uuid.UUID(bytes_le=bytes(scheme.contents.bytes)))
    timeout = wintypes.DWORD()
    powrprof.PowerReadACValueIndex(None, scheme, ctypes.byref(_GUID.of(SUB_VIDEO)), ctypes.byref(_GUID.of(VIDEO_IDLE)),
                                   ctypes.byref(timeout))
    ctypes.windll.kernel32.LocalFree(scheme)
    overlay = _GUID()
    powrprof.PowerGetEffectiveOverlayScheme(ctypes.byref(overlay))
    overlay_id = str(uuid.UUID(bytes_le=bytes(overlay.bytes)))
    last = _LastInput(ctypes.sizeof(_LastInput), 0)
    ctypes.windll.user32.GetLastInputInfo(ctypes.byref(last))
    idle_s = (ctypes.windll.kernel32.GetTickCount() - last.time) / 1000.0
    return {
        "t": time.time(),
        "ac": status.ac == 1, "battery_percent": status.percent, "battery_saver": status.saver == 1,
        "scheme": name.raw[:size.value].decode("utf-16-le").rstrip("\0"), "scheme_guid": scheme_id,
        "overlay": OVERLAYS.get(overlay_id, overlay_id),
        "display_timeout_ac_s": timeout.value, "input_idle_s": round(idle_s, 1),
        "display": ("on" if timeout.value == 0 or idle_s < timeout.value else "off (inferred)"),
    }


if __name__ == "__main__":
    print(json.dumps(read(), indent=1, ensure_ascii=False))
