"""Deleting flashcards (ratings follow the cards that stay) and dismissing finished jobs."""
import json
import time

from fastapi.testclient import TestClient

from studyapp import db
from studyapp.api import app


def test_delete_cards_renumbers_ratings():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Cards', ?)", (now,))
    cards = [{"front": f"q{i}", "back": f"a{i}"} for i in range(4)]
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
                "VALUES (?, 'flashcards', 'Deck', ?, 'ready', ?, ?)", (sid, json.dumps({"cards": cards}), now, now))
    c = TestClient(app)
    try:
        c.put(f"/artifacts/{aid}/cards/1/rating", json={"rating": "struggling"})
        c.put(f"/artifacts/{aid}/cards/3/rating", json={"rating": "confident"})
        r = c.post(f"/artifacts/{aid}/cards/delete", json={"indices": [0, 2, 99]})
        assert r.json()["count"] == 2
        left = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (aid,))["content"])["cards"]
        assert [x["front"] for x in left] == ["q1", "q3"]
        ratings = {r["card_index"]: r["rating"] for r in db.q("SELECT * FROM card_ratings WHERE artifact_id=?", (aid,))}
        assert ratings == {0: "struggling", 1: "confident"}
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_dismiss_only_finished_jobs():
    now = time.time()
    done = db.ex("INSERT INTO jobs(type, status, created_at, updated_at) VALUES ('ingest', 'done', ?, ?)", (now, now))
    live = db.ex("INSERT INTO jobs(type, status, created_at, updated_at) VALUES ('ingest', 'queued', ?, ?)", (now, now))
    c = TestClient(app)
    try:
        c.post("/jobs/dismiss")
        ids = {j["id"] for j in c.get("/jobs").json()}
        assert done not in ids and live in ids
    finally:
        db.ex("DELETE FROM jobs WHERE id IN (?, ?)", (done, live))
