"""Subject/topic order, the outline later notes and cheat-sheet parts are told about (so they don't repeat earlier
ones), and chat titles."""
import time

from fastapi.testclient import TestClient

from studyapp import chat_api, generate, notehtml
from studyapp import db
from studyapp.api import app


def test_subject_and_topic_order():
    now = time.time()
    a = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Aaa order', ?)", (now,))
    b = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Bbb order', ?)", (now,))
    t1 = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'T1', ?)", (a, now))
    t2 = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'T2', ?)", (a, now))
    c = TestClient(app)
    try:
        assert c.put("/subjects/order", json={"ids": [b, a]}).status_code == 200
        assert c.put(f"/subjects/{a}/topics/order", json={"ids": [t2, t1]}).status_code == 200
        subjects = c.get("/subjects").json()
        ids = [s["id"] for s in subjects]
        assert ids.index(b) < ids.index(a)
        assert [t["id"] for t in next(s for s in subjects if s["id"] == a)["topics"]] == [t2, t1]
    finally:
        db.ex("DELETE FROM subjects WHERE id IN (?, ?)", (a, b))


def test_outline_lists_headings_and_terms():
    html = ('<h2>Encryption</h2><div class="def"><span class="term">Cipher</span> an algorithm [[a.pptx · Slide 2]]</div>'
            '<h3>Symmetric &amp; asymmetric</h3><p>…</p>')
    assert notehtml.outline(html) == ["Encryption; defines Cipher", "  Symmetric & asymmetric"]


def test_cheatsheet_parts_see_earlier_parts(monkeypatch):
    tasks = []

    def fake_page(system, task, art, prog, label, max_tokens=16000, allow_empty=False):
        tasks.append(task)
        if len(tasks) == 3:
            return None  # a later part with nothing new is skipped
        return {"html": f"<h2>Topic {len(tasks)}</h2>", "figures": {}}
    monkeypatch.setattr(generate, "_page", fake_page)
    groups = [{"sections": [{"topic": f"T{i}", "title": "x", "tokens": 1, "text": ""}], "text": "", "tokens": 1} for i in range(3)]
    out = generate.gen_cheatsheet({"scope": "S", "subject_id": 1, "topic_id": None}, {"focus": "CIA triad"}, groups,
                                  lambda *a: None)
    assert "earlier parts" not in tasks[0]
    assert "Topic 1" in tasks[1] and "Do NOT repeat" in tasks[1]
    assert "Topic 2" in tasks[2]
    assert [s["title"] for s in out["sections"]] == ["Part 1 · T0", "Part 2 · T1"]


def test_clean_title():
    assert chat_api._clean_title('Title: "SQL Joins vs Subqueries."\nmore') == "SQL Joins vs Subqueries"
    assert chat_api._clean_title("<think>hmm</think>Snell's Law") == "Snell's Law"


# ---------------------------------------------------------------- chats: one blank chat, soft delete, stop, usage

def _subject_row(name):
    return db.ex("INSERT INTO subjects(name, created_at) VALUES (?, ?)", (name, time.time()))


def test_only_one_blank_chat_and_soft_delete():
    sid = _subject_row("Blank chats")
    c = TestClient(app)
    try:
        a = c.post(f"/subjects/{sid}/chats", json={"topic_id": None}).json()
        b = c.post(f"/subjects/{sid}/chats", json={"topic_id": None}).json()
        assert a["id"] == b["id"]  # still empty: the same chat comes back
        chat_api._add_message(a["id"], "user", "hello")
        d = c.post(f"/subjects/{sid}/chats", json={"topic_id": None}).json()
        assert d["id"] != a["id"]
        assert c.post("/chats/delete", json={"ids": [a["id"], d["id"]]}).status_code == 200
        assert c.get(f"/subjects/{sid}/chats").json() == []
        c.post("/chats/restore", json={"ids": [a["id"]]})
        assert [x["id"] for x in c.get(f"/subjects/{sid}/chats").json()] == [a["id"]]
        # a deleted blank chat isn't handed out again
        assert c.post(f"/subjects/{sid}/chats", json={"topic_id": None}).json()["id"] not in (a["id"], d["id"])
        db.ex("UPDATE chats SET deleted_at=? WHERE id=?", (time.time() - 8 * 86400, d["id"]))
        chat_api.purge_deleted_chats()
        assert db.q1("SELECT id FROM chats WHERE id=?", (d["id"],)) is None
        assert db.q1("SELECT id FROM chats WHERE id=?", (a["id"],)) is not None
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def _events(resp):
    import json as _json
    return [_json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]


def test_reply_records_usage_and_stop_keeps_partial(monkeypatch):
    from studyapp import llm
    sid = _subject_row("Usage chats")
    c = TestClient(app)
    from studyapp import chat_reply, chats
    for module in (chat_reply, chats):
        monkeypatch.setattr(module, "_system_prompt", lambda chat: ("rules\n\n=== STUDY MATERIAL ===\nsome material", True))

    def fake_stream(convo, tools=None, max_tokens=0, reasoning="off", cancelled=None):
        yield "content", "Hello "
        yield "content", "there."
        yield "usage", {"prompt": 120, "completion": 30, "reasoning": 0, "cost": None}
        yield "done", "stop"
    monkeypatch.setattr(llm, "chat_stream", fake_stream)
    try:
        cid = c.post(f"/subjects/{sid}/chats", json={"topic_id": None}).json()["id"]
        evs = _events(c.post(f"/chats/{cid}/messages", json={"content": "hi"}))
        reply = next(e for e in evs if e["type"] == "assistant")["message"]
        assert reply["content"] == "Hello there."
        assert reply["meta"]["usage"]["prompt"] == 120 and reply["meta"]["usage"]["completion"] == 30
        stats = c.get(f"/chats/{cid}/stats").json()
        assert stats["replies"] == 1 and stats["prompt"] == 120 and stats["questions"] == 1 and stats["uncounted"] == 0
        ctx = c.get(f"/chats/{cid}/context").json()
        assert ctx["exact"] and ctx["total"] == 150 and ctx["material"] > 0 and ctx["limit"] > 0

        # stopped mid-reply: what was written is kept, marked stopped
        def stopping_stream(convo, tools=None, max_tokens=0, reasoning="off", cancelled=None):
            yield "content", "Partial answer"
            raise llm.StreamCancelled()
        monkeypatch.setattr(llm, "chat_stream", stopping_stream)
        evs = _events(c.post(f"/chats/{cid}/messages", json={"content": "again"}))
        kept = next(e for e in evs if e["type"] == "assistant")["message"]
        assert kept["content"] == "Partial answer" and kept["meta"]["stopped"] is True
        assert any(e["type"] == "stopped" for e in evs)
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_todo_artifact_and_document_order():
    sid = _subject_row("Order lists")
    c = TestClient(app)
    try:
        t1 = c.post(f"/subjects/{sid}/todos", json={"text": "one"}).json()["id"]
        t2 = c.post(f"/subjects/{sid}/todos", json={"text": "two"}).json()["id"]
        c.put(f"/subjects/{sid}/todos/order", json={"ids": [t1, t2]})
        assert [t["id"] for t in c.get(f"/subjects/{sid}/todos").json()] == [t1, t2]
        now = time.time()
        a1, a2 = (db.ex("INSERT INTO artifacts(subject_id, type, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                        (sid, "quiz", t, "ready", now, now)) for t in ("A", "B"))
        assert [a["id"] for a in c.get(f"/subjects/{sid}/library").json()] == [a2, a1]  # newest first
        c.put(f"/subjects/{sid}/artifacts/order", json={"ids": [a1, a2]})
        assert [a["id"] for a in c.get(f"/subjects/{sid}/library").json()] == [a1, a2]
        assert c.get("/palette").status_code == 200
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_generated_content_and_notes_delete_softly():
    """Deleting generated content or a note hides it everywhere and can be undone; a week later it's purged."""
    import time as _t
    from studyapp import study_api
    sid = _subject_row("Soft deletes")
    c = TestClient(app)
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, status, params, content, created_at, updated_at) "
                "VALUES (?, 'notes', 'Waves', 'ready', '{}', '{\"sections\": []}', ?, ?)", (sid, _t.time(), _t.time()))
    nid = c.post(f"/subjects/{sid}/notes", json={"title": "Mine"}).json()["id"]
    listed = lambda: ([a["id"] for a in c.get(f"/subjects/{sid}/library").json()],
                      [n["id"] for n in c.get(f"/subjects/{sid}/notes").json()])
    assert listed() == ([aid], [nid])
    c.delete(f"/artifacts/{aid}")
    c.delete(f"/notes/{nid}")
    assert listed() == ([], [])
    pal = c.get("/palette").json()
    assert aid not in [a["id"] for a in pal["artifacts"]] and nid not in [n["id"] for n in pal["notes"]]
    assert c.get(f"/artifacts/{aid}").status_code == 404 and c.get(f"/notes/{nid}").status_code == 404
    c.post(f"/artifacts/{aid}/restore")
    c.post(f"/notes/{nid}/restore")
    assert listed() == ([aid], [nid])
    c.delete(f"/artifacts/{aid}")
    db.ex("UPDATE artifacts SET deleted_at=? WHERE id=?", (_t.time() - 8 * 86400, aid))
    study_api.purge_deleted()
    assert db.q1("SELECT id FROM artifacts WHERE id=?", (aid,)) is None
    assert db.q1("SELECT id FROM user_notes WHERE id=?", (nid,)) is not None  # not deleted: kept
