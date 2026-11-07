"""The knowledge cloud projection, including tiny libraries (fewer chunks than dimensions)."""
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studyapp import db, llm, projection
from studyapp.api import app


@pytest.fixture
def library(settings):
    settings(embed_provider="local", embed_model="test-embed")
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Proj', ?)", (time.time(),))
    did = db.ex("INSERT INTO documents(subject_id, kind, filename, ext, sha256, size, status, vision_mode, created_at, updated_at) "
                "VALUES (?, 'reference', 'p.txt', '.txt', 'x', 1, 'ready', 'off', ?, ?)", (sid, time.time(), time.time()))
    rng = np.random.default_rng(0)

    def add(n, model="test-embed"):
        for i in range(n):
            v = rng.normal(size=64).astype(np.float32)
            db.ex("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count, embedding, embed_model) "
                  "VALUES (?, 0, 0, ?, 't', 1, ?, ?)", (did, f"c{i}", v.tobytes(), model))
    yield add
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))
    db.ex("DELETE FROM cloud_axes")
    db.ex("DELETE FROM cloud_points")
    projection._cache.clear()


@pytest.mark.parametrize("n", [1, 2, 3, 40])
def test_points_for_any_library_size(library, n):
    library(n)
    pts = TestClient(app).get("/embeddings/map").json()["points"]
    assert len(pts) == n
    xyz = np.array([p[2:5] for p in pts])
    assert np.isfinite(xyz).all() and np.abs(xyz).max() < 10


def test_only_current_model_vectors(library):
    library(5)
    library(7, model="other-model")
    m = TestClient(app).get("/embeddings/map").json()
    assert m["model"] == llm.embed_model() == "test-embed" and len(m["points"]) == 5


def test_subject_scope(library):
    library(6)
    sid = db.q1("SELECT id FROM subjects WHERE name='Proj'")["id"]
    other = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Other', ?)", (time.time(),))
    try:
        c = TestClient(app)
        assert len(c.get(f"/embeddings/map?subject_id={sid}").json()["points"]) == 6
        assert c.get(f"/embeddings/map?subject_id={other}").json()["points"] == []
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (other,))


def test_layout_stays_put_as_chunks_arrive(library):
    """New chunks join the stored axes: existing points don't move, until the scope grows past REFIT_DRIFT."""
    library(40)
    c = TestClient(app)
    first = {p[0]: p[2:5] for p in c.get("/embeddings/map").json()["points"]}
    library(5)  # +12.5%: projected onto the stored axes
    second = {p[0]: p[2:5] for p in c.get("/embeddings/map").json()["points"]}
    assert len(second) == 45 and all(second[i] == xyz for i, xyz in first.items())
    projection._cache.clear()  # a restart: positions come back from cloud_points, unchanged
    assert {p[0]: p[2:5] for p in c.get("/embeddings/map").json()["points"]} == second
    library(20)  # past the drift: refitted
    third = {p[0]: p[2:5] for p in c.get("/embeddings/map").json()["points"]}
    assert len(third) == 65 and any(third[i] != xyz for i, xyz in first.items())
    c.post("/embeddings/map/refit")
    assert db.q1("SELECT COUNT(*) n FROM cloud_axes")["n"] == 0
    assert len(c.get("/embeddings/map").json()["points"]) == 65


def test_sample_is_stable_and_capped(library, monkeypatch):
    monkeypatch.setattr(projection, "MAX_POINTS", 30)
    library(50)
    c = TestClient(app)
    a = [p[0] for p in c.get("/embeddings/map").json()["points"]]
    library(2)
    b = [p[0] for p in c.get("/embeddings/map").json()["points"]]
    assert len(a) == len(b) == 30 and len(set(a) & set(b)) >= 27  # adding chunks swaps only a few in
    assert db.q1("SELECT COUNT(*) n FROM cloud_points")["n"] == 30  # swapped-out points are pruned


def test_top_components_match_svd():
    rng = np.random.default_rng(1)
    mat = (rng.normal(size=(300, 50)) * np.array([10, 6, 3] + [0.5] * 47)).astype(np.float32)
    mat -= mat.mean(axis=0)
    axes = projection.top_components(mat)
    _, _, vt = np.linalg.svd(mat, full_matrices=False)
    for a, b in zip(axes, vt[:3]):
        assert abs(abs(float(a @ b)) - 1) < 1e-3  # same axis (up to sign)
        assert a[np.abs(a).argmax()] > 0  # sign fixed: largest loading positive


def test_folders_are_rows(library):
    """Folders: create (with files), rename, place, order, delete; a file leaving its topic leaves its folder."""
    sid = db.q1("SELECT id FROM subjects WHERE name='Proj'")["id"]
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'T', ?)", (sid, time.time()))
    other = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'U', ?)", (sid, time.time()))
    docs = [db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, "
                  "created_at, updated_at) VALUES (?, ?, 'topic', ?, '.txt', ?, 1, 'ready', 'off', ?, ?)",
                  (sid, tid, f"f{i}.txt", f"s{i}", time.time(), time.time())) for i in range(3)]
    c = TestClient(app)
    assert c.get(f"/subjects/{sid}/folders").json() == {}
    a = c.post(f"/subjects/{sid}/folders", json={"topic_id": tid, "name": "Week 2", "doc_ids": docs[:2]}).json()["id"]
    b = c.post(f"/subjects/{sid}/folders", json={"topic_id": tid, "name": "Week 1"}).json()["id"]
    m = c.get(f"/subjects/{sid}/folders").json()[str(tid)]
    assert [f["name"] for f in m["folders"]] == ["Week 2", "Week 1"] and not m["ordered"]
    assert m["files"] == {str(docs[0]): a, str(docs[1]): a}
    c.put("/folders/place", json={"doc_ids": [docs[1], docs[2]], "folder_id": int(b)})
    c.put(f"/topics/{tid}/folders/order", json={"ids": [int(b), int(a)]})
    c.patch(f"/folders/{a}", json={"name": "Week Two"})
    m = c.get(f"/subjects/{sid}/folders").json()[str(tid)]
    assert m["ordered"] and m["folders"] == [{"id": b, "name": "Week 1"}, {"id": a, "name": "Week Two"}]
    assert m["files"] == {str(docs[0]): a, str(docs[1]): b, str(docs[2]): b}
    # an old order (an undo) never drops folders made since
    n = c.post(f"/subjects/{sid}/folders", json={"topic_id": tid, "name": "New"}).json()["id"]
    c.put(f"/topics/{tid}/folders/order", json={"ids": [int(a), int(b)]})
    assert [f["id"] for f in c.get(f"/subjects/{sid}/folders").json()[str(tid)]["folders"]] == [a, b, n]
    # a file of another topic can't go in; a file moved to another topic leaves its folder
    c.put("/folders/place", json={"doc_ids": [docs[0]], "folder_id": int(n)})
    db.ex("UPDATE documents SET topic_id=? WHERE id=?", (other, docs[0]))
    assert str(docs[0]) not in c.get(f"/subjects/{sid}/folders").json()[str(tid)]["files"]
    c.put("/folders/place", json={"doc_ids": [docs[0]], "folder_id": int(b)})
    assert db.q1("SELECT folder_id FROM documents WHERE id=?", (docs[0],))["folder_id"] is None
    c.delete(f"/folders/{b}")
    m = c.get(f"/subjects/{sid}/folders").json()[str(tid)]
    assert b not in [f["id"] for f in m["folders"]] and m["files"] == {}
    assert db.q1("SELECT COUNT(*) n FROM documents WHERE id IN (?,?,?)", docs)["n"] == 3  # files stay
