"""Study packs: export a subject/topic/files to one zip and import it elsewhere without parsing or re-embedding."""
import hashlib
import json
import time
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studyapp import config, db, llm, pipeline
from studyapp.api import app
from studyapp.chunker import chunk_units

client = TestClient(app)


@pytest.fixture
def embeds(settings, monkeypatch):
    settings(embed_provider="local", embed_model="test-embed", dedupe_units=True, pause_embed=False)
    seen = []

    def fake(texts, query=False):
        seen.extend(texts)
        v = np.array([[float(len(t) % 5 + 1), 1.0, 2.0] for t in texts], dtype=np.float32)
        return v / np.linalg.norm(v, axis=1, keepdims=True)
    monkeypatch.setattr(llm, "embed", fake)
    return seen


@pytest.fixture
def library(embeds):
    """A subject with a topic of two files (the second repeats a page of the first) and a textbook."""
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, color, created_at) VALUES ('Chemistry', '#ff8800', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Acids', ?)", (sid, now))

    def doc(topic_id, name, units, notes=None):
        raw = f"original bytes of {name}".encode()
        sha = hashlib.sha256(raw).hexdigest()
        (config.files_dir() / f"{sha}.pdf").write_bytes(raw)
        did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
                    "created_at, updated_at) VALUES (?,?,?,?,'.pdf',?,?,'ready','all',?,?,?)",
                    (sid, topic_id, "topic" if topic_id else "reference", name, sha, len(raw), len(units), now, now))
        (config.assets_dir() / str(did)).mkdir(parents=True, exist_ok=True)
        (config.assets_dir() / str(did) / "vision_0.png").write_bytes(b"\x89PNG fake")
        scope = pipeline.scope_doc_ids(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
        with db.tx() as c:
            for i, (text, h) in enumerate(units):
                original = pipeline.dedupe.find_original(c, scope, h)
                if notes and i == 0:
                    text = f"{text}\n\n{pipeline.ANNOTATIONS_HEADER}\n- Note: {notes}"
                    original = None
                c.execute("INSERT INTO units(document_id, idx, kind, label, text, content_hash, duplicate_of, token_count, needs_vision, "
                          "vision_status, vision_notes, vision_relevant, vision_image) VALUES (?,?,'page',?,?,?,?,20,1,'done',?,1,?)",
                          (did, i, f"Page {i + 1}", text, h, original, f"A diagram on {name} page {i + 1}.", f"{did}/vision_0.png"))
        kept = db.q("SELECT idx, kind, label, text FROM units WHERE document_id=? AND duplicate_of IS NULL ORDER BY idx", (did,))
        with db.tx() as c:
            for ch in chunk_units(kept, 600, 5):
                cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,?,?,?,?,?)",
                                (did, ch["unit_start"], ch["unit_end"], ch["label"], ch["text"], ch["token_count"])).lastrowid
                c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, ch["text"]))
        pipeline.index_vision(did, embed=False)
        pipeline.embed_chunks(did)
        if notes:
            db.ex("INSERT INTO annotations(document_id, unit, kind, anchor, data, created_at, updated_at) VALUES (?, 0, 'note', '{}', ?, ?, ?)",
                  (did, json.dumps({"text": notes}), now, now))
        return did

    shared = ("Strong acids ionise completely in water.", "h-strong")
    d1 = doc(tid, "acids.pdf", [shared, ("pH = -log[H3O+].", "h-ph")], notes="remember the minus sign")
    d2 = doc(tid, "bases.pdf", [shared, ("Bases accept protons.", "h-bases")])
    d3 = doc(None, "textbook.pdf", [("Chapter 1: matter.", "h-ch1")])
    yield {"sid": sid, "tid": tid, "docs": (d1, d2, d3)}
    for s in db.q("SELECT id FROM subjects WHERE name LIKE 'Chemistry%'"):
        for d in db.q("SELECT id FROM documents WHERE subject_id=?", (s["id"],)):
            pipeline.clear_document(d["id"])
        db.ex("DELETE FROM subjects WHERE id=?", (s["id"],))
    db.ex("DELETE FROM jobs")


def _subject_docs(sid):
    return db.q("SELECT * FROM documents WHERE subject_id=? ORDER BY id", (sid,))


def test_preview_lists_annotated_files(library, embeds):
    r = client.post("/export/preview", json={"subject_id": library["sid"]}).json()
    assert r["documents"] == 3 and [a["filename"] for a in r["annotated"]] == ["acids.pdf"]


def test_round_trip_with_notes(library, embeds, tmp_path):
    pack = tmp_path / "chem.apollo.zip"
    n = len(embeds)
    r = client.post("/export", json={"subject_id": library["sid"], "include_notes": True, "path": str(pack)})
    assert r.status_code == 200, r.text
    assert len(embeds) == n  # nothing changed, nothing embedded
    with zipfile.ZipFile(pack) as z:
        m = json.loads(z.read("manifest.json"))
        assert {d["filename"] for d in m["documents"]} == {"acids.pdf", "bases.pdf", "textbook.pdf"}
        assert m["topics"][0]["name"] == "Acids" and m["embed_model"] == "test-embed"

    prev = client.post("/import/preview", json={"path": str(pack)}).json()
    assert prev["same_model"] and len(prev["documents"]) == 3
    r = client.post("/import", json={"path": str(pack), "subject_name": "Chemistry (shared)"}).json()
    assert r["imported"] == 3 and r["reembedding"] == 0 and not r["skipped"]
    assert len(embeds) == n  # imported vectors are used as they are
    docs = _subject_docs(r["subject_id"])
    assert [d["kind"] for d in docs] == ["topic", "topic", "reference"]
    assert db.q1("SELECT name FROM topics WHERE id=?", (docs[0]["topic_id"],))["name"] == "Acids"
    # the shared page is still a duplicate inside the import; notes and assets came along
    assert db.q1("SELECT duplicate_of FROM units WHERE document_id=? AND idx=0", (docs[1]["id"],))["duplicate_of"] is not None
    assert db.q("SELECT kind FROM annotations WHERE document_id=?", (docs[0]["id"],)) == [{"kind": "note"}]
    u = db.q1("SELECT vision_image FROM units WHERE document_id=? AND idx=0", (docs[0]["id"],))
    assert u["vision_image"] == f"{docs[0]['id']}/vision_0.png" and (config.assets_dir() / u["vision_image"]).is_file()
    assert not db.q1("SELECT 1 FROM chunks WHERE document_id=? AND embedding IS NULL", (docs[0]["id"],))
    assert not db.q("SELECT id FROM jobs WHERE type IN ('ingest','embed','vision')")

    # importing the same pack into that subject again skips every file
    again = client.post("/import", json={"path": str(pack), "subject_id": r["subject_id"]}).json()
    assert again["imported"] == 0 and len(again["skipped"]) == 3


def test_export_without_notes_embeds_clean_copies(library, embeds, tmp_path):
    pack = tmp_path / "clean.zip"
    n = len(embeds)
    client.post("/export", json={"topic_id": library["tid"], "include_notes": False, "path": str(pack)})
    assert embeds[n:] and all(pipeline.ANNOTATIONS_HEADER not in t for t in embeds[n:])
    with zipfile.ZipFile(pack) as z:
        m = json.loads(z.read("manifest.json"))
        assert len(m["documents"]) == 2 and not m["notes_included"]
        data = json.loads(z.read("data/d1.json"))
        assert not data["annotations"]
        assert all(pipeline.ANNOTATIONS_HEADER not in u["text"] for u in data["units"])
        assert all(pipeline.ANNOTATIONS_HEADER not in c["text"] for c in data["chunks"])


def test_single_file_carries_content_it_shared(library, embeds, tmp_path):
    """bases.pdf's first page duplicates acids.pdf; exported alone, it brings that page's text and notes itself."""
    pack = tmp_path / "one.zip"
    client.post("/export", json={"document_ids": [library["docs"][1]], "path": str(pack)})
    r = client.post("/import", json={"path": str(pack), "subject_name": "Chemistry solo"}).json()
    (doc,) = _subject_docs(r["subject_id"])
    assert db.q1("SELECT duplicate_of, vision_status FROM units WHERE document_id=? AND idx=0", (doc["id"],)) == \
        {"duplicate_of": None, "vision_status": "done"}
    texts = [c["text"] for c in db.q("SELECT text FROM chunks WHERE document_id=?", (doc["id"],))]
    assert any("Strong acids" in t for t in texts) and any("visual content" in t for t in texts)


def test_other_model_vectors_are_made_again(library, embeds, tmp_path, settings):
    pack = tmp_path / "model.zip"
    client.post("/export", json={"document_ids": [library["docs"][2]], "path": str(pack)})
    settings(embed_model="another-embed")
    prev = client.post("/import/preview", json={"path": str(pack)}).json()
    assert not prev["same_model"]
    r = client.post("/import", json={"path": str(pack), "subject_name": "Chemistry other"}).json()
    assert r["reembedding"] == 1 and db.q("SELECT id FROM jobs WHERE type='embed'")


def test_rejects_damaged_or_foreign_zips(tmp_path, library):
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("hello.txt", "hi")
    assert client.post("/import/preview", json={"path": str(bad)}).status_code == 400
    evil = tmp_path / "evil.zip"
    with zipfile.ZipFile(evil, "w") as z:
        z.writestr("manifest.json", json.dumps({"format": "apollo-study-pack", "version": 1, "subject": {"name": "x"},
                                                "documents": [{"key": "../../x", "sha256": "0" * 64, "ext": ".pdf", "kind": "topic"}]}))
    assert client.post("/import", json={"path": str(evil)}).status_code == 400
