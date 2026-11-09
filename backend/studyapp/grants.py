"""Path grants: the backend only reads or writes a file outside its data folder when the student picked it.

Electron's main process owns the file dialogs and drag-and-drop paths. For each path the student picks it issues a
grant, HMAC-SHA256(key, "<mode>\\n<normalised path>"), where the key is a per-launch secret the main process and this
backend share (env APOLLO_GRANT_KEY) and the page never sees. The renderer sends the grants it was given in the
X-Apollo-Grants header (base64url JSON {path: grant}); `require()` checks them. So injected script in the page
(e.g. through rendered model output) can't make the backend read or write any other path, even with the API token.

Without a key (tests, a backend started by hand for development) checks are off. Paths inside the data folder (chat
screenshots, imports of the app's own files) are always readable."""
import base64
import contextvars
import hashlib
import hmac
import json
import os
from pathlib import Path

from fastapi import HTTPException

from . import config

KEY: str | None = None
_given: contextvars.ContextVar[dict] = contextvars.ContextVar("grants", default={})


_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def normalise(path: str) -> str:
    """The form Electron signs (main.cjs grant()): absolute, with backslashes on Windows, and only A-Z lowercased, a
    rule Node and Python agree on exactly (their full Unicode lowercasing differs, e.g. for "İ")."""
    p = os.path.abspath(path)
    return p.translate(_ASCII_LOWER) if os.name == "nt" else p


def sign(path: str, mode: str) -> str:
    return hmac.new(KEY.encode(), f"{mode}\n{normalise(path)}".encode(), hashlib.sha256).hexdigest()


def load_header(value: str | None):
    """Called by the API middleware for each request."""
    given = {}
    if value:
        try:
            raw = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
            given = {normalise(str(p)): str(g) for p, g in raw.items()} if isinstance(raw, dict) else {}
        except (ValueError, TypeError):
            given = {}
    return _given.set(given)


def reset(token):
    _given.reset(token)


def _inside_data(path: str) -> bool:
    data = normalise(str(config.DATA_DIR))
    return normalise(path).startswith(data.rstrip("\\/") + os.sep)


def require(path: str, mode: str = "read") -> Path:
    """The path, if the student granted it for `mode` ("read" or "write"); otherwise 403."""
    if KEY and not (mode == "read" and _inside_data(path)):
        grant = _given.get().get(normalise(path))
        if not grant or not hmac.compare_digest(grant, sign(path, mode)):
            raise HTTPException(403, f"[APO-FILE-302] {Path(path).name}: choose this file with the app's file picker (or drop it in) first")
    return Path(path)
