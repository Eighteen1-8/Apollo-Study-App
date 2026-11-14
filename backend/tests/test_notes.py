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
    # the keyword index isn't cleared by the cascade: later tests reuse the chunk ids
    db.ex("DELETE FROM chunks_fts WHERE rowid NOT IN (SELECT id FROM chunks)")


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
    assert db.q1("SELECT label FROM jobs WHERE type='review' AND ref_id=? ORDER BY id DESC", (r["id"],))["label"] == "Revise: N"
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r["id"],))  # no model in tests
    result = {"comment": "done", "sections": [{"index": 0, "html": "<p>new</p>"}]}
    db.ex("UPDATE reviews SET status='ready', result=? WHERE id=?", (json.dumps(result), r["id"]))
    c.post(f"/reviews/{r['id']}/apply")
    assert c.get(f"/notes/{n['id']}").json()["html"] == "<p>new</p>"
    c.post(f"/reviews/{r['id']}/undo")
    assert c.get(f"/notes/{n['id']}").json()["html"] == "<p>old</p>"
    c.post(f"/reviews/{r['id']}/dismiss")
    assert c.get(f"/reviews?target=note&target_id={n['id']}").json() == []


def test_revise_keeps_pasted_pictures_out_of_the_prompt(subject, monkeypatch):
    """A note with a pasted picture: the model sees a placeholder, the revision gets the picture back."""
    c = TestClient(app)
    pic = "data:image/png;base64," + "iVBORw0KGgo" + "Q" * 20000
    n = c.post(f"/subjects/{subject}/notes", json={"title": "Pic", "html": f'<p>old text</p><img src="{pic}">'}).json()
    r = c.post("/reviews", json={"target": "note", "target_id": n["id"], "mode": "revise", "instruction": "fix it"}).json()
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r["id"],))
    seen = []

    def fake_chat(messages, **kw):
        task = messages[-1]["content"]
        seen.append(task)
        body = task.split("===\n", 1)[1].split("\n=== END", 1)[0]
        return {"content": "<comment>Fixed.</comment>" + body.replace("old text", "new text"), "finish": "stop", "usage": {}}
    monkeypatch.setattr(review.llm, "chat", fake_chat)

    class Job:
        def check(self): pass
        def update(self, *a): pass
    review.run_review(r["id"], Job())
    assert "base64" not in seen[0] and "apollo-image:1" in seen[0]
    html = json.loads(db.q1("SELECT result FROM reviews WHERE id=?", (r["id"],))["result"])["sections"][0]["html"]
    assert "new text" in html and pic in html


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
    # app_info: one section, words matched to a section, or everything
    status, cmds = chat_api._read_tool(chat, {"name": "app_info", "arguments": {"topic": "commands"}}, [], "")
    assert status == "Checking what I can do" and "/stats" in cmds and "/help" in cmds
    _, privacy = chat_api._read_tool(chat, {"name": "app_info", "arguments": {"topic": "is my data private offline"}}, [], "")
    assert "Privacy" in privacy
    _, everything = chat_api._read_tool(chat, {"name": "app_info", "arguments": {}}, [], "")
    assert "Why Apollo" in everything and "Ctrl+K" in everything


def test_chat_reads_a_marking_but_never_reviews_it(subject):
    now = time.time()
    content = {"marking": {
        "score": 7, "out_of": 10, "scaled": False, "raw": {"awarded": 7, "available": 10}, "files": ["essay.docx"],
        "rubric": "rubric.pdf", "material": "Physics › Forces", "derived": False, "pages": [],
        "overall": "A solid answer.", "strengths": ["Clear diagrams"], "improvements": ["Show units"],
        "criteria": [{"label": "Q1", "awarded": 3, "max": 4, "feedback": "2 kg at 4 N is 2 m/s².",
                      "corrections": ["a = F/m = 2 m/s²"], "quotes": [{"text": "a = 3", "page": 1}], "pages": [1]},
                     {"label": "Q2", "awarded": 4, "max": 6, "feedback": "Units missing.", "corrections": [], "quotes": [], "pages": []}],
    }}
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
                "VALUES (?, 'marking', 'Forces essay marking', ?, 'ready', ?, ?)", (subject, json.dumps(content), now, now))
    db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
          "VALUES (?, 'quiz', 'Forces quiz', '{}', 'ready', ?, ?)", (subject, now, now))
    chat = {"subject_id": subject, "topic_id": None}
    _, listing = chat_api._read_tool(chat, {"name": "list_content", "arguments": {}}, [], "")
    assert "Forces essay marking (Apollo's marking" in listing and "Forces quiz" not in listing
    _, text = chat_api._read_tool(chat, {"name": "read_content", "arguments": {"title": "essay marking"}}, [], "")
    assert "Score: 7 out of 10" in text and "Overall: A solid answer." in text and "- Show units" in text
    assert "## Q1: 3 of 4 marks" in text and "(page 1): “a = 3”" in text and "- a = F/m = 2 m/s²" in text
    assert "## Q2: 4 of 6 marks" in text and "Units missing." in text
    # readable, but never checked or rewritten (from the app or from chat's review_content)
    c = TestClient(app)
    r = c.post("/reviews", json={"target": "artifact", "target_id": aid, "mode": "check"})
    assert r.status_code == 400 and "marking" in r.json()["detail"]


def _material(subject, kind, texts):
    """A ready file of one page per text, indexed for keyword search (no vectors). Returns (topic id, chunk ids)."""
    now = time.time()
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Circuits', ?)", (subject, now)) if kind == "topic" else None
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
                "token_count, created_at, updated_at) VALUES (?,?,?,?,'.pdf',?,1,'ready','off',?,?,?,?)",
                (subject, tid, kind, f"{kind}.pdf", f"sha-{kind}-{now}", len(texts), 50 * len(texts), now, now))
    cids = []
    for i, t in enumerate(texts):
        db.ex("INSERT INTO units(document_id, idx, kind, label, text, content_hash, token_count) VALUES (?,?,'page',?,?,?,50)",
              (did, i, f"Page {i + 1}", t, f"h-{did}-{i}"))
        cid = db.ex("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,?,?,?,?,10)",
                    (did, i, i, f"Page {i + 1}", f"[Page {i + 1}]\n{t}"))
        db.ex("DELETE FROM chunks_fts WHERE rowid=?", (cid,))  # left by an earlier test's cascaded delete
        db.ex("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, f"[Page {i + 1}]\n{t}"))
        cids.append(cid)
    return tid, cids


def test_search_material_brings_only_new_passages(subject):
    _, (c1, c2) = _material(subject, "topic", ["A resistor limits current.", "Resistor colour codes give the resistance."])
    _material(subject, "reference", ["Textbook: a resistor obeys Ohm's law."])
    chat = {"subject_id": subject, "topic_id": None}
    seen = {c1}  # already given this turn (auto-retrieved)
    call = {"name": "search_material", "arguments": {"query": "resistor"}}
    status, first = chat_api._read_tool(chat, call, [], "", seen)
    assert status.startswith("Looking deeper") and "colour codes" in first and "limits current" not in first
    assert c2 in seen
    _, again = chat_api._read_tool(chat, call, [], "", seen)
    assert "nothing new found" in again
    _, tb = chat_api._read_tool(chat, {"name": "search_material", "arguments": {"query": "resistor", "where": "textbooks"}}, [], "", seen)
    assert "Ohm's law" in tb and "colour codes" not in tb


def test_tutor_rules_dials_tools_and_textbooks(subject):
    from studyapp import chat_prompt
    c = TestClient(app)
    try:
        assert c.put("/settings", json={"chat_concise": 3}).status_code == 200
        assert "Be very concise" in chat_prompt._rules("S")
        assert c.put("/settings", json={"chat_concise": 4}).status_code == 400
        assert c.put("/settings", json={"chat_interactive": 3}).status_code == 400
    finally:
        c.put("/settings", json={"chat_concise": 1})
    with_tools, without = chat_prompt._rules("S", tools=True), chat_prompt._rules("S", tools=False)
    assert "app_info" in with_tools and "search_material" in with_tools
    assert "app_info" not in without and "add_todos" not in without
    assert chat_prompt.NAME_RULE in without and "```plot" in without  # who it is and how to draw stay
    assert chat_prompt.TEXTBOOK_RULE not in with_tools and chat_prompt.TEXTBOOK_RULE in chat_prompt._rules("S", textbooks=True)
    _material(subject, "topic", ["Current is the flow of charge."])
    assert not chat_prompt.has_textbooks(subject, None)
    _material(subject, "reference", ["Charge is quantised."])
    assert chat_prompt.has_textbooks(subject, None)


def test_reply_quote_reads_as_a_reply():
    from studyapp import chat_prompt
    text = chat_prompt._user_text("why?", {"quote": {"kind": "reply", "message_id": 5, "text": "the current halves", "filename": ""}})
    assert text.startswith('[The student is replying to this part of your earlier answer: "the current halves"]')
    assert text.endswith("why?") and "highlighted a passage" not in text
    passage = chat_prompt._user_text("why?", {"quote": {"filename": "a.pdf", "label": "Page 1", "text": "x", "before": "", "after": ""}})
    assert "highlighted a passage in [[a.pdf · Page 1]]" in passage


def _events(resp):
    return [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


def test_chat_searches_material_over_several_rounds(subject, monkeypatch):
    """The model searches, searches again (getting only new passages), then answers; each search shows a status."""
    from studyapp import chat_reply, llm
    _material(subject, "topic", ["A resistor limits current.", "Resistor colour codes give the resistance."])
    monkeypatch.setattr(chat_reply, "_system_prompt", lambda chat: ("rules", True))
    convos = []

    def fake_stream(convo, tools=None, max_tokens=0, reasoning="off", cancelled=None):
        convos.append([dict(m) for m in convo])
        assert any(t["function"]["name"] == "search_material" for t in tools)
        if len(convos) < 3:
            yield "tool_calls", [{"id": f"c{len(convos)}", "name": "search_material", "arguments": {"query": "resistor"}}]
        else:
            yield "content", "Resistors limit current [[topic.pdf · Page 1]]."
        yield "done", "stop"
    monkeypatch.setattr(llm, "chat_stream", fake_stream)
    c = TestClient(app)
    cid = c.post(f"/subjects/{subject}/chats", json={"topic_id": None}).json()["id"]
    evs = _events(c.post(f"/chats/{cid}/messages", json={"content": "what do resistors do?"}))
    assert len(convos) == 3
    first, second = convos[1][-1]["content"], convos[2][-1]["content"]
    assert convos[1][-1]["role"] == "tool" and "limits current" in first and "colour codes" in first
    assert "nothing new found" in second  # the same query again brings nothing already given
    assert sum(e["type"] == "status" and e["text"].startswith("Looking deeper") for e in evs) == 2
    reply = next(e for e in evs if e["type"] == "assistant")["message"]
    assert reply["content"].startswith("Resistors limit current")


# ---------------------------------------------------------------- mind maps and drawings

MAP = {"nodes": [{"id": "a", "x": 0, "y": 0, "text": "Voltage", "shape": "box", "color": ""},
                 {"id": "b", "x": 200, "y": 0, "text": "Current", "shape": "rounded", "color": "blue"},
                 {"id": "c", "x": 0, "y": 200, "text": "Lonely", "shape": "circle", "color": ""}],
       "edges": [{"id": "e1", "from": "a", "to": "b", "label": "drives"}, {"id": "e2", "from": "a", "to": "zz", "label": ""}]}


class _Job:
    def check(self): pass
    def update(self, *a): pass


def _png(w=40, h=30) -> str:
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), "white").save(buf, "PNG")
    import base64
    return base64.b64encode(buf.getvalue()).decode()


def test_note_kinds_crud(subject):
    c = TestClient(app)
    m = c.post(f"/subjects/{subject}/notes", json={"kind": "map", "data": MAP}).json()
    assert m["kind"] == "map" and m["title"] == "Untitled mind map" and m["data"]["nodes"][0]["text"] == "Voltage"
    d = c.post(f"/subjects/{subject}/notes", json={"kind": "drawing", "title": "Circuit"}).json()
    assert d["kind"] == "drawing" and d["data"] == {}
    assert c.post(f"/subjects/{subject}/notes", json={"kind": "poem"}).status_code == 400
    assert c.post(f"/subjects/{subject}/notes", json={"kind": "map", "data": {"nodes": "x"}}).status_code == 400
    c.patch(f"/notes/{d['id']}", json={"data": {"items": [{"type": "pen", "points": [[0, 0, 0.5]]}], "description": "a cell"}})
    assert c.get(f"/notes/{d['id']}").json()["data"]["description"] == "a cell"
    assert c.patch(f"/notes/{d['id']}", json={"data": {"items": "x"}}).status_code == 400
    assert c.patch(f"/notes/{d['id']}", json={"data": {"items": [], "pad": "x" * (9 << 20)}}).status_code == 413
    n = c.post(f"/subjects/{subject}/notes", json={"title": "Plain", "html": "<p>x</p>"}).json()
    assert n["kind"] == "note" and n["data"] is None
    assert c.patch(f"/notes/{n['id']}", json={"data": MAP}).status_code == 400
    kinds = {x["title"]: x["kind"] for x in c.get(f"/subjects/{subject}/notes").json()}
    assert kinds == {"Untitled mind map": "map", "Circuit": "drawing", "Plain": "note"}
    # chat reads a map as an outline and a drawing as its title and description
    chat = {"subject_id": subject, "topic_id": None}
    _, listing = chat_api._read_tool(chat, {"name": "list_content", "arguments": {}}, [], "")
    assert "Circuit (the student's own drawing)" in listing and "(the student's own mind map)" in listing
    _, text = chat_api._read_tool(chat, {"name": "read_content", "arguments": {"title": "Untitled mind map"}}, [], "")
    assert "- Voltage\n  - (drives) Current" in text and "- Lonely" in text
    _, text = chat_api._read_tool(chat, {"name": "read_content", "arguments": {"title": "Circuit"}}, [], "")
    assert "Circuit" in text and "a cell" in text
    # only checks, never rewrites
    assert c.post("/reviews", json={"target": "note", "target_id": m["id"], "mode": "revise", "instruction": "x"}).status_code == 400


def test_map_review_reads_boxes_and_links(subject, monkeypatch):
    c = TestClient(app)
    m = c.post(f"/subjects/{subject}/notes", json={"kind": "map", "title": "Ohm map", "data": MAP}).json()
    text = review.map_text(MAP)
    assert "- Voltage → Current (drives)" in text and "Boxes not linked to anything: Lonely" in text and "zz" not in text
    r = c.post("/reviews", json={"target": "note", "target_id": m["id"], "mode": "check"}).json()
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r["id"],))
    seen = []

    def fake_chat(messages, **kw):
        seen.append(messages)
        return {"content": json.dumps({"verdict": "mostly_correct", "summary": "One link is backwards.", "issues": [
            {"quote": "Voltage → Current", "problem": "p", "fix": "f"}]}), "finish": "stop", "usage": {}}
    monkeypatch.setattr(review.llm, "chat", fake_chat)
    review.run_review(r["id"], _Job())
    task = seen[0][-1]["content"]
    assert "MIND MAP TO CHECK: Ohm map" in task and "Voltage → Current (drives)" in task
    out = c.get(f"/reviews/{r['id']}").json()
    assert out["status"] == "ready" and out["result"]["issues"][0]["quote"] == "Voltage → Current"


def test_drawing_snapshot_and_review_sends_the_picture(subject, monkeypatch):
    from studyapp import errors, notes_api, study_api
    c = TestClient(app)
    d = c.post(f"/subjects/{subject}/notes", json={"kind": "drawing", "title": "Cell",
                                                   "data": {"items": [], "description": "a galvanic cell"}}).json()
    # no picture yet: can't be checked
    assert c.post("/reviews", json={"target": "note", "target_id": d["id"], "mode": "check"}).status_code == 400
    assert c.post(f"/notes/{d['id']}/snapshot", json={"png": "not base64!"}).status_code == 400
    assert c.post(f"/notes/{d['id']}/snapshot", json={"png": "aGVsbG8="}).status_code == 400  # not an image
    import base64
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, "JPEG")
    assert c.post(f"/notes/{d['id']}/snapshot", json={"png": base64.b64encode(buf.getvalue()).decode()}).status_code == 400
    n = c.post(f"/subjects/{subject}/notes", json={"title": "Text"}).json()
    assert c.post(f"/notes/{n['id']}/snapshot", json={"png": _png()}).status_code == 400  # not a drawing
    ok = c.post(f"/notes/{d['id']}/snapshot", json={"png": "data:image/png;base64," + _png()}).json()
    assert ok["width"] == 40 and notes_api.snapshot_path(d["id"]).is_file()

    r = c.post("/reviews", json={"target": "note", "target_id": d["id"], "mode": "check"}).json()
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r["id"],))
    seen = []

    def fake_chat(messages, **kw):
        seen.append(messages)
        return {"content": json.dumps({"verdict": "correct", "summary": "Looks right.", "issues": []}), "finish": "stop", "usage": {}}
    monkeypatch.setattr(review.llm, "chat", fake_chat)
    review.run_review(r["id"], _Job())
    user = seen[0][-1]["content"]
    assert isinstance(user, list) and "a galvanic cell" in user[0]["text"]
    assert user[1]["type"] == "image_url" and user[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "STUDY MATERIAL" in seen[0][0]["content"] or "No study material" in seen[0][0]["content"]
    assert c.get(f"/reviews/{r['id']}").json()["result"]["verdict"] == "correct"

    # a model without vision: a plain error with its own code
    r2 = c.post("/reviews", json={"target": "note", "target_id": d["id"], "mode": "check"}).json()
    db.ex("UPDATE jobs SET status='cancelled' WHERE type='review' AND ref_id=?", (r2["id"],))

    def blind(messages, **kw):
        raise errors.http_error(400, '{"error": "image input is not supported by this model"}', "llm", "chat")
    monkeypatch.setattr(review.llm, "chat", blind)
    with pytest.raises(errors.AppError) as e:
        review.run_review(r2["id"], _Job())
    assert e.value.code == "APO-GEN-410"

    # purged a week after deletion, with its picture
    c.delete(f"/notes/{d['id']}")
    db.ex("UPDATE user_notes SET deleted_at=? WHERE id=?", (time.time() - 8 * 86400, d["id"]))
    study_api.purge_deleted()
    assert not notes_api.snapshot_path(d["id"]).exists()
