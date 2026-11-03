"""The UI's types (app/src/api.ts) against what the backend really sends: every field an interface declares as required
must be in the response. Backend rows are plain dicts, so FastAPI's schema can't check this; this test catches a
renamed or dropped column before the UI shows `undefined`."""
import re
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from studyapp import db
from studyapp.api import app

client = TestClient(app)
API_TS = (Path(__file__).resolve().parents[2] / "app" / "src" / "api.ts").read_text(encoding="utf-8")


def _body(name: str) -> tuple[str, list[str]]:
    """The text between an interface's braces, and the interfaces it extends."""
    m = re.search(rf"export interface {name}\b(?:\s+extends\s+([\w,\s]+))?\s*\{{", API_TS)
    assert m, f"interface {name} not in api.ts"
    depth, i = 1, m.end()
    while depth:
        depth += {"{": 1, "}": -1}.get(API_TS[i], 0)
        i += 1
    return API_TS[m.end():i - 1], [p.strip() for p in (m.group(1) or "").split(",") if p.strip()]


def required_fields(name: str) -> set[str]:
    body, parents = _body(name)
    flat, depth = [], 0
    for ch in body:  # drop nested object types so only top-level fields are read
        depth += {"{": 1, "}": -1}.get(ch, 0) if ch in "{}" else 0
        flat.append(ch if depth == 0 or ch == "{" and depth == 1 else " ")
    fields = {m.group(1) for m in re.finditer(r"(?:^|[;\n])\s*(\w+)\s*:", "".join(flat))}
    optional = {m.group(1) for m in re.finditer(r"(?:^|[;\n])\s*(\w+)\s*\?:", "".join(flat))}
    for p in parents:
        fields |= required_fields(p)
    return fields - optional


def check(obj: dict, interface: str):
    missing = required_fields(interface) - set(obj)
    assert not missing, f"{interface}: the backend no longer sends {sorted(missing)}"


@pytest.fixture(scope="module")
def library():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Contract', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Topic', ?)", (sid, now))
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, created_at, "
                "updated_at) VALUES (?, ?, 'topic', 'a.pdf', '.pdf', 'contract', 1, 'ready', 'off', ?, ?)", (sid, tid, now, now))
    db.ex("INSERT INTO artifacts(subject_id, topic_id, type, title, status, created_at, updated_at) VALUES (?, ?, 'quiz', 'Q', "
          "'ready', ?, ?)", (sid, tid, now, now))
    db.ex("INSERT INTO todos(subject_id, text, created_at) VALUES (?, 'revise', ?)", (sid, now))
    db.ex("INSERT INTO jobs(type, document_id, status, created_at, updated_at) VALUES ('ingest', ?, 'done', ?, ?)", (did, now, now))
    yield {"sid": sid, "tid": tid, "did": did}
    db.ex("DELETE FROM jobs WHERE document_id=?", (did,))
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_parser_reads_required_and_optional_fields():
    assert {"id", "name", "topics", "reference_count", "icon_image"} <= required_fields("Subject")
    assert "stale_docs" not in required_fields("Subject")
    assert {"subject_name", "id", "subject_id"} <= required_fields("TopicDetail")  # with the fields it extends


@pytest.mark.parametrize("path,interface,many", [
    ("/subjects", "Subject", True),
    ("/jobs", "Job", True),
    ("/jobs/pause", "PauseState", False),
    ("/maintenance/overview", "MaintOverview", False),
    ("/backups", "Backups", False),
])
def test_global_endpoints_match_their_types(library, path, interface, many):
    data = client.get(path).json()
    for obj in (data if many else [data]):
        check(obj, interface)


def test_subject_endpoints_match_their_types(library):
    sid, tid, did = library["sid"], library["tid"], library["did"]
    subject = next(s for s in client.get("/subjects").json() if s["id"] == sid)
    check(subject["topics"][0], "Topic")
    check(client.get(f"/topics/{tid}").json(), "TopicDetail")
    for d in client.get(f"/subjects/{sid}/all-documents").json():
        check(d, "DocRef")
    for d in client.get(f"/topics/{tid}/documents").json():
        check(d, "Doc")
    for it in client.get(f"/subjects/{sid}/library").json():
        check(it, "LibraryItem")
    for t in client.get(f"/subjects/{sid}/todos").json():
        check(t, "Todo")
    overview = client.get("/maintenance/overview").json()
    check(next(d for d in overview["documents"] if d["id"] == did), "MaintDoc")


def test_a_missing_field_is_caught():
    with pytest.raises(AssertionError, match="no longer sends"):
        check({"id": 1, "type": "ingest"}, "Job")
    assert {"document_id", "filename", "status", "progress", "message", "error"} <= required_fields("Job")
