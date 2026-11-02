"""Vision notes: output cleaning, the audit's rules, vision chunks in search, and the maintenance endpoints."""
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from studyapp import db, llm, pipeline, search, vision_audit
from studyapp.api import app

GOOD = ("The graph plots velocity (m/s) against time (s). The line rises linearly from the origin to 12 m/s at 4 s, "
        "showing constant acceleration of $3\\,\\text{m/s}^2$.")


def _fake_embed(texts, query=False):
    v = np.array([[float(len(t) % 7 + 1), float("velocity" in t.lower()), float("circuit" in t.lower()), 1.0] for t in texts],
                 dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


@pytest.fixture
def doc(settings, monkeypatch):
    settings(embed_provider="local", embed_model="test-embed")
    monkeypatch.setattr(llm, "embed", _fake_embed)
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Vision', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Kinematics', ?)", (sid, now))
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, created_at, updated_at) "
                "VALUES (?, ?, 'topic', 'scan.pdf', '.pdf', 'nosuchfile', 1, 'ready', 'all', ?, ?)", (sid, tid, now, now))

    def unit(idx, notes, text="", status="done", relevant=1):
        return db.ex("INSERT INTO units(document_id, idx, kind, label, text, content_hash, token_count, needs_vision, "
                     "vision_status, vision_notes, vision_relevant) VALUES (?, ?, 'page', ?, ?, ?, 1, 1, ?, ?, ?)",
                     (did, idx, f"Page {idx + 1}", text, f"h{did}-{idx}", status, notes, relevant))
    yield {"sid": sid, "tid": tid, "did": did, "unit": unit}
    pipeline.clear_document(did)
    db.ex("DELETE FROM documents WHERE id=?", (did,))
    db.ex("DELETE FROM topics WHERE id=?", (tid,))
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_clean_vision_output():
    assert pipeline.clean_vision_output("<think>hmm</think>\nA graph.") == "A graph."
    assert pipeline.clean_vision_output("reasoning only the template opened\n</think>\n\nA graph.") == "A graph."
    assert pipeline.clean_vision_output("A graph.\n<think>the reply ran out mid-thought") == "A graph."
    assert pipeline.clean_vision_output("<think>never closed") == ""


@pytest.mark.parametrize("notes,kind", [
    ("", "malformed"),
    ("Okay, let me look at this slide. The user wants a description of the graph on it.", "malformed"),
    (GOOD + " <think>wait", "malformed"),
    (GOOD + "\n\n" + pipeline.TRUNCATED, "incomplete"),
    ("I cannot see the image you attached, so here is a general description of a velocity graph.", "misleading"),
    ("Graph:\n" + "\n".join(["The curve rises steeply and then levels off near the top."] * 3), "malformed"),
    ("The equation $v^2 = u^2 + 2as shows how velocity changes with distance under constant acceleration.", "malformed"),
    ("a hydronium ion, $\\text{H}_3\\text{O}^+$$, shown as a red oxygen sphere bonded to three hydrogens", "malformed"),
])
def test_rules_flag(notes, kind):
    assert kind in [k for k, _ in vision_audit.check_notes(notes)]


@pytest.mark.parametrize("notes", [
    GOOD,
    # seen in a real library: none of these is broken
    "Some books cost $15 each and the rest $12.50. Let $n$ be the number of $15 books, so $14-n$ cost $12.50.",
    "- **Vertical axis:** labelled $C$ ($), ticks at 25, 50 and 100.\n- Horizontal axis: dollars, $ per kg.",
    "| a | b |\n|---|---|\n" + "\n".join(["| (blank) | (blank) |"] * 9),
    "\n\n".join(f"Handwritten solution:\nStep {i}: multiply both sides by {i} and simplify." for i in range(5)),
    r"Sophie deposits $6000 a year; $100 000 is invested; answers: 1 a $7092.60, 4 a $39\,918.13. Let $n$ books cost $15, so $14-n$ cost $12.50.",
    "Matrix:\n" + "\n".join([r"1 & 1 & 0 & 0 \\"] * 3),
    "Keyboard row: `#`/`3` · `$`/`4` · `%`/`5` · `^`/`6`. Password example: A4$h*L@9.",
    "H: I really couldn't say. " * 3 + "E: Well, I can't see the heater from here, can you describe it? " + GOOD,
])
def test_rules_pass(notes):
    assert vision_audit.check_notes(notes) == []


def test_vision_chunks_are_searchable_and_follow_flags(doc):
    did = doc["did"]
    doc["unit"](0, GOOD)
    bad = doc["unit"](1, "Okay, let me think about what this circuit image shows before I describe it to the student.")
    doc["unit"](2, None, status="failed")
    db.ex("UPDATE units SET vision_notes='[vision error] timeout' WHERE document_id=? AND idx=2", (did,))
    doc["unit"](3, None, relevant=0)

    assert vision_audit.rule_scan([did]) == 2  # the thinking-aloud page and the failed page
    pipeline.index_vision(did, [0])  # one page (as after re-running vision on it) leaves the backfill to do the rest
    assert db.q1("SELECT vision_indexed FROM documents WHERE id=?", (did,))["vision_indexed"] == 0
    pipeline.index_vision(did)
    assert db.q1("SELECT vision_indexed FROM documents WHERE id=?", (did,))["vision_indexed"] == 1
    rows = db.q("SELECT unit_start, embed_model FROM chunks WHERE document_id=? AND source='vision'", (did,))
    assert [r["unit_start"] for r in rows] == [0] and rows[0]["embed_model"] == "test-embed"

    hits = search.search("velocity time graph", [did])
    assert hits and hits[0]["source"] == "vision" and hits[0]["label"] == "Page 1"
    assert hits[0]["vision_notes"][0]["vision_notes"] == GOOD

    # dismissing the malformed flag puts the page back in the index
    fid = db.q1("SELECT id FROM vision_flags WHERE unit_id=? AND kind='malformed'", (bad,))["id"]
    c = TestClient(app)
    c.post("/maintenance/vision-flags/dismiss", json={"ids": [fid]})
    assert db.q1("SELECT 1 FROM chunks WHERE document_id=? AND source='vision' AND unit_start=1", (did,))
    assert vision_audit.rule_scan([did]) == 1  # a dismissed flag isn't raised again


def test_notes_shown_once_per_search(doc):
    did = doc["did"]
    doc["unit"](0, GOOD, text="Velocity time graph for a cart accelerating")
    with db.tx() as c:
        cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,0,0,'Page 1',"
                        "'[Page 1]\nVelocity time graph for a cart accelerating', 5)", (did,)).lastrowid
        c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, "[Page 1]\nVelocity time graph for a cart accelerating"))
    pipeline.index_vision(did)
    pipeline.embed_chunks(did)
    hits = search.search("velocity graph", [did])
    assert len(hits) == 1 and len(hits[0]["vision_notes"]) == 1


def test_scan_rerun_and_overview(doc):
    did = doc["did"]
    doc["unit"](0, GOOD)
    doc["unit"](1, "", status="done")
    c = TestClient(app)
    r = c.post("/maintenance/vision-scan", json={"document_id": did, "review": False}).json()
    assert r["rule_flags"] == 1
    flags = c.get(f"/maintenance/vision-flags?subject_id={doc['sid']}").json()
    assert [(f["unit"], f["kind"], f["source"]) for f in flags] == [(1, "malformed", "rule")]

    ov = c.get("/maintenance/overview").json()
    d = next(x for x in ov["documents"] if x["id"] == did)
    assert d["flags"] == 1 and d["missing"] and d["topic_id"] == doc["tid"]

    r = c.post("/maintenance/vision-rerun", json={"flag_ids": [flags[0]["id"]]}).json()
    assert r == {"units": 1, "queued": 1}
    assert db.q1("SELECT vision_status FROM units WHERE document_id=? AND idx=1", (did,))["vision_status"] == "pending"
    assert not db.q1("SELECT 1 FROM vision_flags WHERE document_id=? AND dismissed=0", (did,))
    db.ex("UPDATE jobs SET status='cancelled' WHERE document_id=?", (did,))
