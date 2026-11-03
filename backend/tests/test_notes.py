"""The student's notes (never ingested), Apollo's reviews of them (applied and undone without the model), highlights on
generated content, Word export, interactive work in the jobs list, and the chat's read-only tools."""
import io
import json
import time

import pytest
from docx import Document
from fastapi.testclient import TestClient

from studyapp import chat_api, db, jobs, pipeline, review
from studyapp.api import app


@pytest.fixture
def subject():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Notes subject', ?)", (now,))
    yield sid
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_notes_crud_and_not_ingested(subject):
    c = TestClient(app)
    n = c.post(f"/subjects/{subject}/notes", json={"title": "Ohm", "html": "<p>V = IR<script>x()</script></p>"}).json()
    assert "<script" not in n["html"]
    c.patch(f"/notes/{n['id']}", json={"html": "<p><b>V</b> = IR</p>", "title": "Ohm's law"})
    assert c.get(f"/notes/{n['id']}").json()["title"] == "Ohm's law"
    assert [x["title"] for x in c.get(f"/subjects/{subject}/notes").json()] == ["Ohm's law"]
    # never part of the material
    assert db.q1("SELECT COUNT(*) n FROM chunks c JOIN documents d ON d.id=c.document_id WHERE d.subject_id=?", (subject,))["n"] == 0
    c.delete(f"/notes/{n['id']}")
    assert c.get(f"/subjects/{subject}/notes").json() == []


def test_revise_review_apply_and_undo(subject):
    c = TestClient(app)
    n = c.post(f"/subjects/{subject}/notes", json={"title": "N", "html": "<p>old</p>"}).json()
    r = c.post("/reviews", json={"target": "note", "target_id": n["id"], "mode": "revise", "instruction": "fix it"}).json()
    assert r["status"] == "queued" and r["target_title"] == "N"
    assert db.q1("SELECT label FROM jobs WHERE type='review' AND ref_id=?", (r["id"],))["label"] == "Revise: N"
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r["id"],))  # no model in tests
    result = {"comment": "done", "sections": [{"index": 0, "html": "<p>new</p>"}]}
    db.ex("UPDATE reviews SET status='ready', result=? WHERE id=?", (json.dumps(result), r["id"]))
    c.post(f"/reviews/{r['id']}/apply")
    assert c.get(f"/notes/{n['id']}").json()["html"] == "<p>new</p>"
    c.post(f"/reviews/{r['id']}/undo")
    assert c.get(f"/notes/{n['id']}").json()["html"] == "<p>old</p>"
    c.post(f"/reviews/{r['id']}/dismiss")
    assert c.get(f"/reviews?target=note&target_id={n['id']}").json() == []


def test_revise_needs_instruction_and_reviewable_target(subject):
    c = TestClient(app)
    n = c.post(f"/subjects/{subject}/notes", json={}).json()
    assert c.post("/reviews", json={"target": "note", "target_id": n["id"], "mode": "revise"}).status_code == 400
    now = time.time()
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
                "VALUES (?, 'flashcards', 'Deck', '{}', 'ready', ?, ?)", (subject, now, now))
    assert c.post("/reviews", json={"target": "artifact", "target_id": aid, "mode": "check"}).status_code == 400


def test_artifact_sections_swap(subject):
    now = time.time()
    content = {"sections": [{"title": "A", "html": "<p>a</p>", "figures": {}}, {"title": "B", "html": "<p>b</p>"}]}
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
                "VALUES (?, 'cheatsheet', 'Sheet', ?, 'ready', ?, ?)", (subject, json.dumps(content), now, now))
    owner, secs = review.target_sections({"target": "artifact", "target_id": aid})
    assert [s["title"] for s in secs] == ["A", "B"]
    c = TestClient(app)
    r = c.post("/reviews", json={"target": "artifact", "target_id": aid, "mode": "revise", "instruction": "x", "section": 1}).json()
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r["id"],))
    db.ex("UPDATE reviews SET status='ready', result=? WHERE id=?",
          (json.dumps({"comment": "", "sections": [{"index": 1, "markdown": "**b2**"}]}), r["id"]))
    c.post(f"/reviews/{r['id']}/apply")
    secs = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (aid,))["content"])["sections"]
    assert secs[1] == {"title": "B", "markdown": "**b2**"} and secs[0]["html"] == "<p>a</p>"
    c.post(f"/reviews/{r['id']}/undo")
    secs = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (aid,))["content"])["sections"]
    assert secs[1] == {"title": "B", "html": "<p>b</p>"}


def test_marks(subject):
    now = time.time()
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
                "VALUES (?, 'notes', 'Notes', '{}', 'ready', ?, ?)", (subject, now, now))
    c = TestClient(app)
    m = c.post(f"/artifacts/{aid}/marks", json={"section": 0, "start": 3, "end": 9, "text": "abcdef"}).json()
    c.patch(f"/marks/{m['id']}", json={"start": 4, "end": 10})
    assert c.get(f"/artifacts/{aid}/marks").json()[0]["start"] == 4
    c.delete(f"/marks/{m['id']}")
    assert c.get(f"/artifacts/{aid}/marks").json() == []


def test_docx_export():
    c = TestClient(app)
    html = ('<h2>Ohm</h2><p>Text with <b>bold</b>, <span style="background-color: rgb(255, 235, 59)">a highlight</span> '
            'and $V=IR$.</p><ul><li>one<ul><li>two</li></ul></li></ul><table><tr><th>a</th><td>1</td></tr></table>')
    r = c.post("/export/docx", json={"title": "My note", "html": html})
    assert r.status_code == 200
    doc = Document(io.BytesIO(r.content))
    text = [p.text for p in doc.paragraphs]
    assert "My note" in text and "Ohm" in text and "two" in text
    assert any("$V=IR$" in t for t in text)
    assert doc.tables[0].cell(0, 1).text == "1"


def test_tracked_job_lifecycle():
    with jobs.track("define", "Define x") as t:
        row = db.q1("SELECT * FROM jobs WHERE id=?", (t.id,))
        assert row["status"] == "running" and row["label"] == "Define x"
        assert not t.cancelled()
    assert db.q1("SELECT status FROM jobs WHERE id=?", (t.id,))["status"] == "done"
    with pytest.raises(pipeline.Cancelled):
        with jobs.track("chat", "Chat") as t2:
            jobs.cancel(t2.id)
            t2._checked = 0  # skip the throttle
            if t2.cancelled():
                raise pipeline.Cancelled()
    assert db.q1("SELECT status FROM jobs WHERE id=?", (t2.id,))["status"] == "cancelled"
    c = TestClient(app)
    listed = {j["id"]: j for j in c.get("/jobs").json()}
    assert listed[t.id]["filename"] == "Define x"


def test_read_tools(subject):
    now = time.time()
    db.ex("INSERT INTO todos(subject_id, text, note, done, created_at) VALUES (?, 'Revise circuits', '', 0, ?)", (subject, now))
    db.ex("INSERT INTO user_notes(subject_id, title, html, created_at, updated_at) VALUES (?, 'Circuit notes', '<p>R = V/I</p>', ?, ?)",
          (subject, now, now))
    chat = {"subject_id": subject, "topic_id": None}
    _, todos = chat_api._read_tool(chat, {"name": "view_todos", "arguments": {}}, [], "")
    assert "[ ] Revise circuits" in todos
    _, listing = chat_api._read_tool(chat, {"name": "list_content", "arguments": {}}, [], "")
    assert "Circuit notes" in listing
    _, text = chat_api._read_tool(chat, {"name": "read_content", "arguments": {"title": "circuit"}}, [], "")
    assert "R = V/I" in text
