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


# ---------------------------------------------------------------- deletes, resumed ingest, reads during writes

def test_delete_hands_shared_pages_to_the_files_that_duplicated_them(subject, embeds):
    shared = ("Ohm's law: V = IR.", "h-ohm-shared")
    d1 = _doc(subject["sid"], subject["a"], "owner.pdf", [shared])
    db.ex("UPDATE units SET needs_vision=1, vision_status='done', vision_notes='A circuit diagram.', vision_relevant=1 "
          "WHERE document_id=?", (d1,))
    d2 = _doc(subject["sid"], subject["a"], "copy.pdf", [shared, ("Only here.", "h-only")])
    assert db.q1("SELECT duplicate_of FROM units WHERE document_id=? AND idx=0", (d2,))["duplicate_of"] is not None
    client.delete(f"/documents/{d1}")
    u = db.q1("SELECT duplicate_of, vision_status, vision_notes FROM units WHERE document_id=? AND idx=0", (d2,))
    assert u == {"duplicate_of": None, "vision_status": "done", "vision_notes": "A circuit diagram."}
    assert any("Ohm" in t for t in _vectors(d2)) and not db.q("SELECT id FROM jobs WHERE type IN ('ingest','vision')")
    assert [j["document_id"] for j in db.q("SELECT document_id FROM jobs WHERE type='embed'")] == [d2]


def test_an_interrupted_ingest_only_finishes_embedding(subject, embeds, monkeypatch):
    d = _doc(subject["sid"], subject["a"], "big.pdf", [("Page one.", "h-p1"), ("Page two.", "h-p2")])
    db.ex("UPDATE chunks SET embedding=NULL, embed_model=NULL WHERE document_id=?", (d,))
    db.ex("UPDATE documents SET status='embedding', parser_version=? WHERE id=?", (pipeline.PARSER_VERSION, d))
    monkeypatch.setattr(pipeline, "parse", lambda *a, **k: pytest.fail("parsed again"))

    class Job:
        def update(self, *a): pass
        def check(self): pass
    n = len(embeds)
    assert pipeline.ingest(d, Job()) == 0
    assert len(embeds) == n + 1 and db.q1("SELECT status FROM documents WHERE id=?", (d,))["status"] == "ready"


def test_reads_do_not_wait_for_a_write_in_progress(subject):
    import threading
    started, finish, seen = threading.Event(), threading.Event(), []

    def writer():
        with db.tx() as c:
            c.execute("UPDATE subjects SET name='Renamed' WHERE id=?", (subject["sid"],))
            started.set()
            finish.wait(5)
    t = threading.Thread(target=writer)
    t.start()
    started.wait(5)
    reader = threading.Thread(target=lambda: seen.append(db.q1("SELECT name FROM subjects WHERE id=?", (subject["sid"],))["name"]))
    reader.start()
    reader.join(2)
    assert seen == ["Moves"]  # answered at once, from before the uncommitted write
    finish.set()
    t.join()
    assert db.q1("SELECT name FROM subjects WHERE id=?", (subject["sid"],))["name"] == "Renamed"


def test_cleanup_drops_dangling_rows_and_unused_cache_files(subject):
    from studyapp import config
    fig = config.assets_dir() / "figures"
    fig.mkdir(parents=True, exist_ok=True)
    (fig / "unused.png").write_bytes(b"x")
    (fig / "used.png").write_bytes(b"x")
    db.ex("INSERT OR REPLACE INTO figure_cache(key, data) VALUES ('k-used', ?)", ('{"asset": "figures/used.png"}',))
    db.ex("INSERT OR REPLACE INTO figure_cache(key, data) VALUES ('k-gone', ?)", ('{"asset": "figures/missing.png"}',))
    db.ex("INSERT OR REPLACE INTO snapshots(path, document_id, unit, rect, created_at) VALUES ('C:/nowhere/s.png', 1, 1, '[]', 0)")
    for _ in range(2):
        db.ex("INSERT INTO practice_exams(subject_id, filename, sha256, text, created_at) VALUES (?, 'p.pdf', 'same', 't', 0)",
              (subject["sid"],))
    o = client.get("/maintenance/overview").json()
    assert o["stale_rows"] >= 3 and o["orphans"]["cache"]["count"] >= 1
    client.post("/maintenance/cleanup", json={})
    assert not (fig / "unused.png").exists() and (fig / "used.png").exists()
    assert db.q1("SELECT 1 FROM figure_cache WHERE key='k-gone'") is None and db.q1("SELECT 1 FROM figure_cache WHERE key='k-used'")
    assert db.q1("SELECT COUNT(*) n FROM practice_exams WHERE subject_id=?", (subject["sid"],))["n"] == 1
    assert db.q1("SELECT 1 FROM snapshots WHERE path='C:/nowhere/s.png'") is None
    db.ex("DELETE FROM figure_cache")


def test_files_read_by_an_older_parser_are_listed_and_can_be_read_again(subject, embeds):
    d = _doc(subject["sid"], subject["a"], "old.pdf", [("Old text.", "h-old")])
    db.ex("UPDATE documents SET parser_version='1' WHERE id=?", (d,))
    doc = next(x for x in client.get("/maintenance/overview").json()["documents"] if x["id"] == d)
    assert doc["old_parser"]
    assert client.post("/maintenance/reparse", json={"document_id": d}).json() == {"queued": 1}
    assert db.q1("SELECT ref_id FROM jobs WHERE type='ingest' AND document_id=?", (d,))["ref_id"] == pipeline.KEEP_VISION


def test_search_vector_cache_follows_changes(subject, embeds):
    from studyapp import search

    def vecs(d):  # (chunk ids, matrix) of one document, as the cache holds it
        ids, mats = search._vectors([d], "test-embed")
        return (list(ids[0]), mats[0]) if ids else ([], None)
    d = _doc(subject["sid"], subject["a"], "cache.pdf", [("First page.", "h-c1")])
    ids, mat = vecs(d)
    entry = search._docs[(d, "test-embed")]
    assert len(ids) == 1
    again_ids, again = vecs(d)
    assert again is mat and search._docs[(d, "test-embed")] is entry  # unchanged: nothing read again
    # a chunk deleted and re-added under the same id with a different vector is noticed
    top = db.q1("SELECT id, text FROM chunks WHERE document_id=? ORDER BY id DESC LIMIT 1", (d,))
    db.ex("UPDATE chunks SET embedding=? WHERE id=?", (np.array([9, 1, 1], dtype=np.float32).tobytes(), top["id"]))
    assert not np.array_equal(vecs(d)[1], mat)
    cid = db.ex("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?, 0, 0, 'x', 'Second.', 2)", (d,))
    pipeline.embed_chunks(d)
    ids, mat = vecs(d)
    assert cid in ids and len(ids) == 2
    # similarities over a scope: one score per chunk, no combined copy kept
    sid_ids, sims = search.similarities([d], "test-embed", np.array([1, 0, 0], dtype=np.float32))
    assert list(sid_ids) == ids and sims.shape == (2,)
    db.ex("DELETE FROM chunks WHERE id=?", (cid,))
    assert len(vecs(d)[0]) == 1


def test_run_next_and_long_jobs_yield(subject, monkeypatch):
    db.ex("DELETE FROM jobs")
    a = jobs.enqueue("vision", None, 101)
    b = jobs.enqueue("vision", None, 102)
    pick = lambda: db.q1("SELECT id FROM jobs WHERE type IN ('vision','audit') AND status='queued' "
                         "ORDER BY priority DESC, COALESCE(queued_at, created_at), id LIMIT 1")["id"]
    assert pick() == a
    assert client.post(f"/jobs/{b}/prioritize").status_code == 200 and pick() == b
    # a running vision job steps aside at once for a job that outranks it, and after its slice for any other
    db.ex("UPDATE jobs SET status='running' WHERE id=?", (a,))
    running = jobs.Job(db.q1("SELECT * FROM jobs WHERE id=?", (a,)), "vision")
    assert running.should_yield()
    db.ex("UPDATE jobs SET priority=0 WHERE id=?", (b,))
    running = jobs.Job(db.q1("SELECT * FROM jobs WHERE id=?", (a,)), "vision")
    assert not running.should_yield()
    monkeypatch.setattr(jobs, "SLICE", -1)
    assert running.should_yield()
    db.ex("UPDATE jobs SET status='cancelled' WHERE id=?", (b,))
    assert not running.should_yield()  # nothing waiting: keep going
    assert client.post(f"/jobs/{a}/prioritize").status_code == 400  # running, not waiting
    db.ex("DELETE FROM jobs")
