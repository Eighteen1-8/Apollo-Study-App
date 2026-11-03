"""Moving files keeps their embeddings (dedupe links are recomputed, nothing re-ingested), whole-subject scopes fall back
to the reference library, and pausing a model holds background jobs while chat is told straight away."""
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studyapp import context, db, jobs, llm, pipeline
from studyapp.api import app
from studyapp.chunker import chunk_units

client = TestClient(app)


@pytest.fixture
def embeds(settings, monkeypatch):
    """Fake embedding model; returns the list of every text embedded."""
    settings(embed_provider="local", embed_model="test-embed", dedupe_units=True)
    seen = []

    def fake(texts, query=False):
        seen.extend(texts)
        v = np.array([[float(len(t) % 5 + 1), 1.0, float(len(texts))] for t in texts], dtype=np.float32)
        return v / np.linalg.norm(v, axis=1, keepdims=True)
    monkeypatch.setattr(llm, "embed", fake)
    return seen


@pytest.fixture
def subject():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Moves', ?)", (now,))
    a = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'A', ?)", (sid, now))
    b = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'B', ?)", (sid, now))
    yield {"sid": sid, "a": a, "b": b}
    for d in db.q("SELECT id FROM documents WHERE subject_id=?", (sid,)):
        pipeline.clear_document(d["id"])
    db.ex("DELETE FROM jobs")
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def _doc(sid, topic_id, name, units):
    """A ready document from (text, content hash) units, deduped and embedded the way ingest leaves one."""
    now = time.time()
    kind = "topic" if topic_id else "reference"
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
                "token_count, created_at, updated_at) VALUES (?,?,?,?,'.pdf',?,1,'ready','off',?,?,?,?)",
                (sid, topic_id, kind, name, f"sha-{name}", len(units), 50 * len(units), now, now))
    scope = pipeline.scope_doc_ids(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    with db.tx() as c:
        for i, (text, h) in enumerate(units):
            original = pipeline.dedupe.find_original(c, scope, h)
            c.execute("INSERT INTO units(document_id, idx, kind, label, text, content_hash, duplicate_of, token_count) "
                      "VALUES (?,?,'page',?,?,?,?,50)", (did, i, f"Page {i + 1}", text, h, original))
    kept = db.q("SELECT idx, kind, label, text FROM units WHERE document_id=? AND duplicate_of IS NULL ORDER BY idx", (did,))
    with db.tx() as c:
        for ch in chunk_units(kept, 600, 5):
            cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,?,?,?,?,?)",
                            (did, ch["unit_start"], ch["unit_end"], ch["label"], ch["text"], ch["token_count"])).lastrowid
            c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, ch["text"]))
    pipeline.embed_chunks(did)
    return did


def _vectors(did):
    return {r["text"]: r["embedding"] for r in db.q("SELECT text, embedding FROM chunks WHERE document_id=?", (did,))}


def test_move_without_shared_content_touches_nothing(subject, embeds):
    d1 = _doc(subject["sid"], subject["a"], "one.pdf", [("Ohm's law relates V, I and R.", "h-ohm")])
    before, n = _vectors(d1), len(embeds)
    r = client.post(f"/documents/{d1}/move", json={"topic_id": subject["b"]})
    assert r.status_code == 200 and r.json()["topic_id"] == subject["b"]
    assert _vectors(d1) == before and len(embeds) == n
    assert not db.q("SELECT id FROM jobs WHERE document_id=?", (d1,))
    assert db.q1("SELECT status FROM documents WHERE id=?", (d1,))["status"] == "ready"


def test_move_relinks_duplicates_and_reuses_vectors(subject, embeds):
    shared = ("Kirchhoff's current law: currents into a node sum to zero.", "h-kcl")
    d1 = _doc(subject["sid"], subject["a"], "first.pdf", [shared, ("Only in the first file.", "h-first")])
    d2 = _doc(subject["sid"], subject["a"], "second.pdf", [shared, ("Only in the second file.", "h-second")])
    assert db.q1("SELECT duplicate_of FROM units WHERE document_id=? AND idx=0", (d2,))["duplicate_of"] is not None
    v1, n = _vectors(d1), len(embeds)

    r = client.post(f"/documents/{d1}/move", json={"topic_id": None})  # to the reference library
    assert r.status_code == 200 and r.json()["kind"] == "reference"
    # the moved file is untouched; the file left behind owns the shared page now
    assert _vectors(d1) == v1
    assert db.q1("SELECT duplicate_of FROM units WHERE document_id=? AND idx=0", (d2,))["duplicate_of"] is None
    assert db.q1("SELECT duplicate_units FROM documents WHERE id=?", (d2,))["duplicate_units"] == 0
    assert not db.q("SELECT id FROM jobs WHERE type='ingest'")
    # only the rebuilt chunk is queued for embedding, and embedding it sends just that text
    assert [j["document_id"] for j in db.q("SELECT document_id FROM jobs WHERE type='embed'")] == [d2]
    assert len(embeds) == n
    pipeline.embed_chunks(d2)
    assert len(embeds) == n + 1 and "Kirchhoff" in embeds[-1]

    # moving it back makes the shared page a duplicate again; the second file's one remaining chunk is new text
    db.ex("DELETE FROM jobs")
    client.post(f"/documents/{d1}/move", json={"topic_id": subject["a"]})
    assert db.q1("SELECT duplicate_of FROM units WHERE document_id=? AND idx=0", (d2,))["duplicate_of"] is not None
    assert all("Kirchhoff" not in t for t in _vectors(d2))
    assert _vectors(d1) == v1 and not db.q("SELECT id FROM jobs WHERE type='ingest'")
    n = len(embeds)
    pipeline.embed_chunks(d2)
    assert embeds[n:] == ["[Page 2]\nOnly in the second file."]


def test_whole_subject_scope_falls_back_to_reference_library(subject, embeds):
    sid = subject["sid"]
    assert "no files yet" in context.material_problem(sid, None)
    _doc(sid, None, "textbook.pdf", [("Chapter 1: atoms and the periodic table.", "h-ch1")])
    docs = context.topic_documents(sid, None)
    assert [d["filename"] for d in docs] == ["textbook.pdf"] and docs[0]["topic_name"] == context.REFERENCE_LABEL
    assert context.uses_reference_material(sid, None)
    assert context.material_problem(sid, None) is None
    assert context.material_groups(sid, None, 10000)
    # one topic chosen: its own files only, with a reason when it has none
    assert "has no files yet" in context.material_problem(sid, subject["a"])
    _doc(sid, subject["a"], "notes.pdf", [("Topic notes on bonding.", "h-bond")])
    assert [d["filename"] for d in context.topic_documents(sid, None)] == ["notes.pdf"]
    assert not context.uses_reference_material(sid, None)


def test_pause_holds_jobs_and_refuses_chat(settings, monkeypatch):
    settings(llm_provider="local")
    monkeypatch.setattr(llm, "_post", lambda cfg, path, body, timeout=1800: {"choices": [{"message": {"content": "hi"}}]})
    assert client.post("/jobs/pause", json={"llm": True}).json()["llm"] is True
    # a settings save from the UI doesn't undo a pause
    client.put("/settings", json={"pause_llm": False, "chat_concise": 1})
    assert llm.paused("llm") and not llm.paused("embed")
    with pytest.raises(llm.Paused):
        llm.chat([{"role": "user", "content": "x"}])
    # a job waits in place until resumed
    waited = []

    def hook(kind):
        waited.append(kind)
        jobs.set_paused(llm_paused=False)
    llm.set_wait_hook(hook)
    try:
        assert llm.chat([{"role": "user", "content": "x"}])["content"] == "hi"
    finally:
        llm.set_wait_hook(None)
    assert waited == ["llm"] and client.get("/jobs/pause").json()["llm"] is False
