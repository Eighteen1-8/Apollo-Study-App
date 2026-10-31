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
