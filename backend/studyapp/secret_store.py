"""API keys at rest: encrypted with Windows DPAPI (CryptProtectData, bound to this Windows user account) before they go
in the settings table, and decrypted only when a model client needs them. Stored as "dpapi:<base64>".

A copied database (a backup moved to another PC or user) therefore has unreadable keys: they show as not set and need
entering again. The root .env that seeds them on first run is the student's own file and stays as they wrote it.
Off Windows there is no DPAPI, and values are kept as they are."""
import base64
import ctypes
import os

PREFIX = "dpapi:"
_ENTROPY = b"Apollo Study API key"


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(buf) -> _Blob:
    return _Blob(len(buf) - 1, ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))  # buffers carry a trailing NUL


def _call(fn, data: bytes) -> bytes:
    src, ent = ctypes.create_string_buffer(data), ctypes.create_string_buffer(_ENTROPY)  # alive for the whole call
    out = _Blob()
    ok = fn(ctypes.byref(_blob(src)), None, ctypes.byref(_blob(ent)), None, None, 0x1, ctypes.byref(out))  # UI_FORBIDDEN
    if not ok:
        raise OSError("DPAPI call failed")
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(out.pbData)


AVAILABLE = os.name == "nt"


def protect(value: str) -> str:
    if not value or not AVAILABLE or value.startswith(PREFIX):
        return value
    return PREFIX + base64.b64encode(_call(ctypes.windll.crypt32.CryptProtectData, value.encode())).decode()


def unprotect(value: str) -> str:
    """The plain key; "" if it was encrypted by another Windows user or computer."""
    if not isinstance(value, str) or not value.startswith(PREFIX):
        return value
    if not AVAILABLE:
        return ""
    try:
        return _call(ctypes.windll.crypt32.CryptUnprotectData, base64.b64decode(value[len(PREFIX):])).decode()
    except (OSError, ValueError):
        return ""
