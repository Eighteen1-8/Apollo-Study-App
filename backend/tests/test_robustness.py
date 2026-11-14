"""Things that must keep working when something goes wrong: a model server that's off or answers badly, a job cancelled
while it waits, a damaged backup, a second copy of the app, a setting typed wrongly."""
import json
import time

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from studyapp import config, db, errors, generate, jobs, llm, main, pipeline, search
from studyapp.api import app

from test_providers import mock_transport


class _Job:
    id = 0

    def check(self):
        pass

    def update(self, *a):
        pass

    def note(self, *a):
        pass

    def should_yield(self):
        return False


@pytest.fixture
def subject():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Robust', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Waves', ?)", (sid, now))
    yield {"sid": sid, "tid": tid}
    for d in db.q("SELECT id FROM documents WHERE subject_id=?", (sid,)):
        pipeline.clear_document(d["id"])
    db.ex("DELETE FROM jobs WHERE document_id IN (SELECT id FROM documents WHERE subject_id=?)", (sid,))
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def _doc(subject, status="ready", name="a.pdf", sha="nosuchfile"):
    now = time.time()
    return db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, created_at, "
                 "updated_at) VALUES (?, ?, 'topic', ?, '.pdf', ?, 1, ?, 'all', ?, ?)",
                 (subject["sid"], subject["tid"], name, sha, status, now, now))


# ---------------------------------------------------------------- storage

def test_nested_transactions_join_the_outer_one():
    with db.tx() as c:
        c.execute("INSERT INTO ui_state(key, value) VALUES ('nest-a', '1')")
        with db.tx() as inner:  # used to fail: "cannot start a transaction within a transaction"
            inner.execute("INSERT INTO ui_state(key, value) VALUES ('nest-b', '2')")
    assert db.q1("SELECT COUNT(*) n FROM ui_state WHERE key LIKE 'nest-%'")["n"] == 2
    with pytest.raises(RuntimeError):
        with db.tx() as c:
            c.execute("DELETE FROM ui_state WHERE key='nest-a'")
            with db.tx() as inner:
                inner.execute("DELETE FROM ui_state WHERE key='nest-b'")
                raise RuntimeError("inner failure undoes both")
    assert db.q1("SELECT COUNT(*) n FROM ui_state WHERE key LIKE 'nest-%'")["n"] == 2
    db.ex("DELETE FROM ui_state WHERE key LIKE 'nest-%'")


def test_damaged_backup_is_not_restored():
    config.backups_dir().mkdir(parents=True, exist_ok=True)
    bad = config.backups_dir() / "study-20200101-000000_000-manual.db"
    bad.write_bytes(b"this is not a database" * 100)
    before = config.db_path().stat().st_size
    try:
        db.request_restore(bad.name)
        db._apply_pending_restore()
        assert db.pending_restore() is None
        assert config.db_path().stat().st_size == before  # the live data was left alone
        assert not config.db_path().with_name("study.db.restoring").exists()
        assert db.q1("SELECT COUNT(*) n FROM settings")["n"] > 0
    finally:
        bad.unlink(missing_ok=True)


def test_only_one_backend_per_data_folder():
    held = main._data_lock
    try:
        assert main._lock_data_dir(wait=0) or held is not None  # this process holds it now
        first = main._data_lock
        assert not main._lock_data_dir(wait=0.2)  # a second holder is refused
        assert main._data_lock is first
    finally:
        if main._data_lock is not None and held is None:
            main._data_lock.close()
            main._data_lock = None
    assert "APO-APP-004" in errors.CATALOGUE


def test_atomic_write_leaves_no_partial_file(tmp_path):
    target = tmp_path / "sub" / "thumb.png"
    config.write_atomic(target, b"abc")
    assert target.read_bytes() == b"abc"
    assert [p.name for p in target.parent.iterdir()] == ["thumb.png"]
    src = tmp_path / "src.bin"
    src.write_bytes(b"x" * 1000)
    config.copy_atomic(src, target)
    assert target.stat().st_size == 1000


# ---------------------------------------------------------------- jobs

def test_cancelling_a_waiting_job_releases_what_it_was_for(subject):
    did = _doc(subject, status="queued")
    now = time.time()
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, status, created_at, updated_at) VALUES (?, 'quiz', 'Q', 'queued', ?, ?)",
                (subject["sid"], now, now))
    exam = db.ex("INSERT INTO artifacts(subject_id, type, title, status, content, created_at, updated_at) "
                 "VALUES (?, 'exam', 'E', 'ready', '{}', ?, ?)", (subject["sid"], now, now))
    att = db.ex("INSERT INTO attempts(artifact_id, answers, status, created_at, updated_at) VALUES (?, '{}', 'marking', ?, ?)",
                (exam, now, now))
    saved = db.setting("pause_embed"), db.setting("pause_llm")
    db.put_settings({"pause_embed": True, "pause_llm": True})  # so no worker (if any runs) picks these up meanwhile
    try:
        ingest, gen, mark = jobs.enqueue("ingest", did), jobs.enqueue("generate", ref_id=aid), jobs.enqueue("mark", ref_id=att)
        for j in (ingest, gen, mark):
            jobs.cancel(j)
            assert db.q1("SELECT status FROM jobs WHERE id=?", (j,))["status"] == "cancelled"
        # each used to stay as it was for good: a file "queued", content "queued", an attempt "marking"
        assert db.q1("SELECT status FROM documents WHERE id=?", (did,))["status"] == "cancelled"
        assert db.q1("SELECT status FROM artifacts WHERE id=?", (aid,))["status"] == "cancelled"
        assert db.q1("SELECT status FROM attempts WHERE id=?", (att,))["status"] == "cancelled"
        jobs.cancel(10 ** 9)  # a job that doesn't exist is not an error
    finally:
        db.put_settings({"pause_embed": saved[0], "pause_llm": saved[1]})
        db.ex("DELETE FROM jobs WHERE ref_id IN (?, ?) OR document_id=?", (aid, att, did))
        db.ex("DELETE FROM artifacts WHERE id IN (?, ?)", (aid, exam))


def test_undoing_the_delete_of_unfinished_content_queues_it_again(subject):
    now = time.time()
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, status, created_at, updated_at) VALUES (?, 'notes', 'N', 'cancelled', ?, ?)",
                (subject["sid"], now, now))
    db.ex("UPDATE artifacts SET deleted_at=? WHERE id=?", (now, aid))
    saved = db.setting("pause_llm")
    db.put_settings({"pause_llm": True})
    c = TestClient(app)
    try:
        assert c.post(f"/artifacts/{aid}/restore").status_code == 200
        assert db.q1("SELECT status FROM artifacts WHERE id=?", (aid,))["status"] == "queued"
        assert db.q1("SELECT COUNT(*) n FROM jobs WHERE type='generate' AND ref_id=? AND status='queued'", (aid,))["n"] == 1
        assert any(a["id"] == aid for a in c.get(f"/subjects/{subject['sid']}/library").json())  # 'cancelled' ones are hidden
    finally:
        db.put_settings({"pause_llm": saved})
        db.ex("DELETE FROM jobs WHERE type='generate' AND ref_id=?", (aid,))
        db.ex("DELETE FROM artifacts WHERE id=?", (aid,))


def test_jobs_for_deleted_things_stop_quietly():
    with pytest.raises(pipeline.Cancelled):
        generate.run_artifact(10 ** 9, _Job())
    with pytest.raises(pipeline.Cancelled):
        generate.run_marking(10 ** 9, _Job())
    with pytest.raises(pipeline.Cancelled):
        pipeline.ingest(10 ** 9, _Job())
    with pytest.raises(pipeline.Cancelled):
        pipeline.run_vision(10 ** 9, _Job())


def test_vision_stops_when_the_model_cannot_be_reached(subject, monkeypatch):
    did = _doc(subject)
    for i in (1, 2, 3):
        db.ex("INSERT INTO units(document_id, idx, kind, label, text, content_hash, token_count, needs_vision, vision_status) "
              "VALUES (?, ?, 'page', ?, '', ?, 1, 1, 'pending')", (did, i, f"Page {i}", f"vs{did}-{i}"))
    calls = []

    def down(*a, **kw):
        calls.append(1)
        raise errors.AppError("APO-LLM-101", "connection refused")
    monkeypatch.setattr(pipeline, "unit_images", lambda doc, u: [b"\x89PNG fake"])
    monkeypatch.setattr(llm, "chat", down)
    with pytest.raises(errors.AppError) as e:
        pipeline.run_vision(did, _Job())
    assert e.value.code == "APO-LLM-101"
    assert len(calls) == 1  # not one failed request per page
    # every page is still waiting, none was written off as failed
    assert {u["vision_status"] for u in db.q("SELECT vision_status FROM units WHERE document_id=?", (did,))} == {"pending"}

    # a problem with one page (the server answered, badly) still only fails that page
    monkeypatch.setattr(llm, "chat", lambda *a, **kw: (_ for _ in ()).throw(errors.AppError("APO-LLM-108", "HTTP 500")))
    monkeypatch.setattr(pipeline, "index_vision", lambda *a, **kw: None)
    pipeline.run_vision(did, _Job())
    assert {u["vision_status"] for u in db.q("SELECT vision_status FROM units WHERE document_id=?", (did,))} == {"failed"}


# ---------------------------------------------------------------- models

def test_search_falls_back_to_keywords_when_embedding_fails(subject, monkeypatch, settings):
    settings(embed_provider="local", embed_model="test-embed", pause_embed=False)
    did = _doc(subject)
    vec = np.ones(4, dtype=np.float32).tobytes()
    cid = db.ex("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count, embedding, embed_model) "
                "VALUES (?, 1, 1, 'Page 1', 'Diffraction bends waves around obstacles', 5, ?, 'test-embed')", (did, vec))
    db.ex("INSERT INTO chunks_fts(rowid, text) VALUES (?, 'Diffraction bends waves around obstacles')", (cid,))

    def offline(texts, query=False):
        raise httpx.ConnectError("refused")
    monkeypatch.setattr(llm, "embed", offline)
    try:
        problems = []
        hits = search.search("diffraction", [did], 5, problems)
        assert [h["chunk_id"] for h in hits] == [cid]  # used to raise, taking the whole chat reply with it
        assert problems and "APO-EMB-201" in problems[0]
        res = TestClient(app).post("/search", json={"query": "diffraction", "topic_id": subject["tid"]}).json()
        assert len(res["results"]) == 1 and "keyword" in res["warning"]
    finally:
        db.ex("DELETE FROM chunks_fts WHERE rowid=?", (cid,))


def test_embedding_reply_must_match_what_was_asked(monkeypatch, settings):
    settings(embed_provider="local", pause_embed=False)
    reply = {"data": [{"index": 0, "embedding": [1.0, 0.0]}]}
    mock_transport(monkeypatch, lambda req: httpx.Response(200, json=reply))
    with pytest.raises(errors.AppError) as e:
        llm.embed(["one", "two"])  # one vector for two texts: chunks would silently go without
    assert e.value.code == "APO-EMB-206"
    reply["data"] = [{"index": 0, "embedding": [0.0, 0.0]}, {"index": 1, "embedding": [3.0, 4.0]}]
    v = llm.embed(["one", "two"])
    assert not np.isnan(v).any() and np.allclose(v[1], [0.6, 0.8])  # a zero vector stays zero, not NaN


def test_stream_survives_a_damaged_chunk(monkeypatch, settings):
    settings(llm_provider="openrouter")
    body = "\n".join([
        ": keep-alive", "",
        'data: {"choices": [{"delta": {"content": "Hel"}}]}', "",
        "data: {this is not json", "",
        'data:{"choices": [{"delta": {"content": "lo"}}]}', "",  # no space after the colon: valid SSE too
        'data: {"choices": [{"delta": {}, "finish_reason": "stop"}]}', "",
        "data: [DONE]", "",
    ]).encode()
    mock_transport(monkeypatch, lambda req: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"}))
    out = list(llm.chat_stream([{"role": "user", "content": "x"}]))
    assert "".join(t for k, t in out if k == "content") == "Hello"
    assert out[-1] == ("done", "stop")


def test_reply_without_choices_is_a_coded_error(monkeypatch, settings):
    settings(llm_provider="local", pause_llm=False)
    mock_transport(monkeypatch, lambda req: httpx.Response(200, json={"choices": []}))
    with pytest.raises(errors.AppError) as e:
        llm.chat([{"role": "user", "content": "x"}])
    assert e.value.code == "APO-LLM-108"


# ---------------------------------------------------------------- generation

def test_exam_items_need_an_answer_key_that_names_an_option():
    ok = generate.ExamQ(type="mcq", prompt="p", marks=1, options=["a", "b"], answer_index=1)
    assert generate._key_ok(ok)
    assert not generate._key_ok(generate.ExamQ(type="mcq", prompt="p", marks=1, options=["a", "b"], answer_index=4))
    assert not generate._key_ok(generate.ExamQ(type="mcq", prompt="p", marks=1, options=["a", "b"]))
    assert generate._key_ok(generate.ExamQ(type="short", prompt="p", marks=2, model_answer="x"))


def test_marking_copes_with_a_bad_answer_key(subject):
    content = {"parts": [{"name": "A", "questions": [
        {"type": "mcq", "prompt": "Pick", "marks": 2, "options": ["a", "b"], "answer_index": 1},
        {"type": "mcq", "prompt": "Old exam, key out of range", "marks": 1, "options": ["a", "b"], "answer_index": 7}]}]}
    now = time.time()
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, status, content, created_at, updated_at) "
                "VALUES (?, 'exam', 'E', 'ready', ?, ?, ?)", (subject["sid"], json.dumps(content), now, now))
    att = db.ex("INSERT INTO attempts(artifact_id, answers, status, created_at, updated_at) VALUES (?, ?, 'marking', ?, ?)",
                (aid, json.dumps({"p0q0": "1"}), now, now))  # the second question is left unanswered
    try:
        generate.run_marking(att, _Job())  # used to raise IndexError on the second question
        r = db.q1("SELECT status, score, total FROM attempts WHERE id=?", (att,))
        assert (r["status"], r["score"], r["total"]) == ("marked", 2.0, 3.0)
    finally:
        db.ex("DELETE FROM artifacts WHERE id=?", (aid,))


@pytest.mark.parametrize("kind,content,empty", [
    ("flashcards", {"cards": []}, True), ("flashcards", {"cards": [{"front": "a"}]}, False),
    ("quiz", {"questions": []}, True), ("exam", {"parts": [{"questions": []}]}, True),
    ("exam", {"parts": [{"questions": [{}]}]}, False), ("mindmap", {"mindmap": {"label": "x", "children": []}}, True),
    ("notes", {"sections": []}, True), ("cheatsheet", {"sections": [{"html": "<p>x</p>"}]}, False),
    ("marking", {"marking": {"criteria": []}}, True), ("marking", {}, True),
    ("marking", {"marking": {"criteria": [{"label": "Q1", "awarded": 1, "max": 2}]}}, False),
])
def test_empty_content_is_never_ready(kind, content, empty):
    assert generate._is_empty(kind, content) is empty


# ---------------------------------------------------------------- the API

def test_settings_are_checked_before_they_are_saved():
    c = TestClient(app)
    before = db.setting("llm_context")
    try:
        r = c.put("/settings", json={"llm_context": "lots"})  # used to be saved, then break every model call
        assert r.status_code == 400 and "llm context" in r.json()["detail"]
        assert db.setting("llm_context") == before
        assert c.put("/settings", json={"llm_context": 0}).status_code == 400
        assert c.put("/settings", json={"dedupe_units": "yes"}).status_code == 400
        assert c.put("/settings", json={"llm_base_url": "localhost:8080"}).json()["code"] == "APO-SET-701"
        assert c.put("/settings", json={"llm_context": "50000", "vision_big_image_area": "0.5"}).status_code == 200
        assert db.setting("llm_context") == 50000 and db.setting("vision_big_image_area") == 0.5
    finally:
        db.put_settings({"llm_context": before, "vision_big_image_area": config.DEFAULT_SETTINGS["vision_big_image_area"]})


def test_names_cannot_be_blanked(subject):
    c = TestClient(app)
    assert c.patch(f"/subjects/{subject['sid']}", json={"name": "   "}).status_code == 400
    assert c.patch(f"/topics/{subject['tid']}", json={"name": ""}).status_code == 400
    assert db.q1("SELECT name FROM subjects WHERE id=?", (subject["sid"],))["name"] == "Robust"


def test_upload_replaces_a_stored_copy_that_was_cut_short(subject, tmp_path):
    src = tmp_path / "notes.txt"
    src.write_text("Refraction is the bending of light.\n" * 50, encoding="utf-8")
    import hashlib
    stored = config.files_dir() / f"{hashlib.sha256(src.read_bytes()).hexdigest()}.txt"
    stored.write_bytes(src.read_bytes()[:10])  # what an interrupted copy used to leave behind, and be reused for good
    saved = db.setting("pause_embed")
    db.put_settings({"pause_embed": True})
    c = TestClient(app)
    try:
        res = c.post("/documents", json={"paths": [str(src), str(tmp_path / "missing.pdf")], "topic_id": subject["tid"]}).json()
        assert [r["status"] for r in res] == ["queued", "error"]  # one bad file doesn't fail the others
        assert stored.stat().st_size == src.stat().st_size
    finally:
        db.put_settings({"pause_embed": saved})
        stored.unlink(missing_ok=True)


def test_snapshot_rejects_areas_it_cannot_cut(subject):
    did = _doc(subject)
    c = TestClient(app)
    assert c.post(f"/documents/{did}/snapshot", json={"unit": 1, "rect": [0.1, 0.1]}).status_code == 400
    assert c.post(f"/documents/{did}/snapshot", json={"unit": 1, "rect": [0.5, 0.5, 0, 0]}).status_code == 400
