"""The example subject is made without any model: its files are read and chunked at once, its content and chat cite
pages that exist, and asking again returns the same subject."""
import json

from fastapi.testclient import TestClient

from studyapp import citations, db, examples
from studyapp.api import app

client = TestClient(app)


def test_example_subject_is_complete_and_made_once():
    r = client.post("/examples/physics").json()
    sid = r["id"]
    try:
        assert r["created"] and client.post("/examples/physics").json() == {"id": sid, "created": False}
        docs = db.q("SELECT * FROM documents WHERE subject_id=? ORDER BY id", (sid,))
        assert [d["unit_count"] for d in docs] == [len(s) for _, _, s in examples.LECTURES]
        assert all(d["status"] == "ready" and d["chunk_count"] > 0 for d in docs)
        page3 = db.q1("SELECT text FROM units WHERE document_id=? AND idx=3", (docs[0]["id"],))["text"]
        assert "Velocity = displacement / time" in page3
        # no embedding model in the tests: vectors wait for embed_waiting, which queues nothing while it's unreachable
        assert not db.q("SELECT id FROM jobs WHERE type='embed' AND document_id IN (SELECT id FROM documents WHERE subject_id=?)", (sid,))
        assert examples.embed_waiting() == 0
        kinds = {a["type"] for a in db.q("SELECT type FROM artifacts WHERE subject_id=? AND status='ready'", (sid,))}
        assert kinds == {"flashcards", "quiz", "notes"}
        # every citation names a real page, and the check leaves them alone (they already point at the right one)
        reply = db.q1("SELECT content FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.subject_id=? AND m.role='assistant'", (sid,))["content"]
        assert citations.verify(reply, sid)[1] == []
        cards = json.loads(db.q1("SELECT content FROM artifacts WHERE subject_id=? AND type='flashcards'", (sid,))["content"])["cards"]
        for c in cards:
            file, label = c["source"].split(" · ")
            doc = citations.doc_for(sid, file)
            assert doc and citations.find_unit(citations._units(doc["id"]), label)
    finally:
        client.delete(f"/subjects/{sid}")
        db.ex("DELETE FROM jobs")
