"""Change notifications for the UI, instead of every panel polling its own query.

One watcher thread computes a small signature per topic about once a second (a few aggregate queries on indexed
tables), and GET /events streams the names of the topics that changed as server-sent events: `data: ["jobs",
"documents"]`. The UI reloads just the panels listening to those topics (hooks.usePoll's `topics`) and keeps a slow
fallback poll in case the stream drops. A comment line every 15 s keeps the connection alive.

Topics: jobs, documents (incl. chunk changes via vec_version), subjects (subjects and topics), library (generated
content), todos, flags (vision flags), pause (paused models), notes (the student's notes), reviews (Apollo checking or
revising them), chats (the chat list and its groups)."""
import hashlib
import json
import threading
import time

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from . import db

router = APIRouter()

INTERVAL = 0.8
KEEPALIVE = 15

_SQL = {
    "jobs": "SELECT COUNT(*), MAX(updated_at), SUM(dismissed) FROM jobs",
    "documents": "SELECT COUNT(*), MAX(updated_at), SUM(vec_version), MAX(id), group_concat(COALESCE(position, ''), ',') FROM documents",
    "subjects": "SELECT (SELECT group_concat(id || name || color || COALESCE(icon_text, '') || COALESCE(icon_emoji, '') || COALESCE(icon_name, '') || "
                "COALESCE(icon_image, '') || COALESCE(position, ''), '|') FROM subjects), "
                "(SELECT group_concat(id || subject_id || name || COALESCE(position, ''), '|') FROM topics)",
    "library": "SELECT COUNT(*), MAX(updated_at), SUM(LENGTH(title)), group_concat(COALESCE(position, ''), ','), "
               "COUNT(deleted_at), SUM(deleted_at) FROM artifacts",
    "todos": "SELECT group_concat(id || done || text || note || COALESCE(topic_id, '') || COALESCE(position, ''), '|') FROM todos",
    "flags": "SELECT COUNT(*), SUM(dismissed), MAX(id) FROM vision_flags",
    "pause": "SELECT group_concat(value, '|') FROM settings WHERE key IN ('pause_llm', 'pause_embed')",
    "notes": "SELECT COUNT(*), MAX(updated_at), SUM(LENGTH(title)), COUNT(deleted_at), SUM(deleted_at) FROM user_notes",
    "reviews": "SELECT COUNT(*), MAX(updated_at), SUM(dismissed) FROM reviews",
    "chats": "SELECT COUNT(*), MAX(updated_at), SUM(LENGTH(title)), COUNT(deleted_at), SUM(deleted_at), "
             "SUM(COALESCE(group_id, 0) * (id % 9973 + 1)), COUNT(group_id), "
             "(SELECT group_concat(id || name || COALESCE(position, '') || COALESCE(deleted_at, ''), '|') FROM chat_groups) FROM chats",
}

_cond = threading.Condition()
_versions: dict[str, int] = {t: 0 for t in _SQL}
_started = False


def _signature(sql: str) -> str:
    rows = db.q(sql)
    return hashlib.blake2b(json.dumps(rows[0] if rows else None, default=str).encode(), digest_size=12).hexdigest()


def _watch():
    last: dict[str, str] = {}
    while True:
        changed = []
        for topic, sql in _SQL.items():
            try:
                sig = _signature(sql)
            except Exception:  # e.g. a table missing on a database mid-restore; try again next pass
                continue
            if last.get(topic) not in (None, sig):
                changed.append(topic)
            last[topic] = sig
        if changed:
            with _cond:
                for t in changed:
                    _versions[t] += 1
                _cond.notify_all()
        time.sleep(INTERVAL)


def start():
    global _started
    if not _started:
        _started = True
        threading.Thread(target=_watch, daemon=True, name="events").start()


def _stream():
    start()
    with _cond:
        seen = dict(_versions)
    yield "retry: 2000\n\n"
    while True:
        with _cond:
            _cond.wait_for(lambda: _versions != seen, timeout=KEEPALIVE)
            changed = [t for t, v in _versions.items() if v != seen[t]]
            seen = dict(_versions)
        yield f"data: {json.dumps(changed)}\n\n" if changed else ": keep-alive\n\n"


@router.get("/events")
def events():
    return StreamingResponse(_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
