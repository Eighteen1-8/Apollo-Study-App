"""A subject's three example questions (the study sheet's placeholder): queued once it has a ready file, made once,
never replaced; the example subject comes with its own."""
import time

from fastapi.testclient import TestClient

from studyapp import db, examples, questions
from studyapp.api import app

client = TestClient(app)


class _Job:
    def note(self, _msg):
        pass


def _subject_with_file(name="Qs"):
    sid = client.post("/subjects", json={"name": name}).json()["id"]
    now = time.time()
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, chunk_count, "
                "created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (sid, None, "reference", "book.pdf", "pdf", "x" * 64, 1, "ready", "off", 1, now, now))
    db.ex("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,?,?,?,?,?)",
          (did, 1, 1, "Page 1", "Photosynthesis turns light into chemical energy in the chloroplast.", 12))
    return sid


def test_questions_are_queued_once_and_made_once(monkeypatch):
    empty = client.post("/subjects", json={"name": "No files yet"}).json()["id"]
    sid = _subject_with_file()
    try:
        assert next(s for s in client.get("/subjects").json() if s["id"] == sid)["questions"] == []
        assert questions.ensure(empty) is None  # nothing to ask about yet
        jid = questions.ensure(sid)
        assert jid and questions.ensure(sid) == jid  # one job, not two
        assert db.q1("SELECT type, ref_id FROM jobs WHERE id=?", (jid,)) == {"type": "questions", "ref_id": sid}

        asked = []

        def fake(messages, model, **kw):
            asked.append(messages[-1]["content"])
            return model(questions=["What does the chloroplast do?", "How is light energy stored?", "Where does photosynthesis happen?"])
        monkeypatch.setattr(questions.llm, "chat_json", fake)
        questions.run(sid, _Job())
        assert "Photosynthesis" in asked[0]
        subj = next(s for s in client.get("/subjects").json() if s["id"] == sid)
        assert subj["questions"][0] == "What does the chloroplast do?" and len(subj["questions"]) == 3

        # made once: never asked again, never replaced
        db.ex("DELETE FROM jobs")
        assert questions.ensure(sid) is None
        assert questions.run(sid, _Job()) is None and len(asked) == 1
    finally:
        client.delete(f"/subjects/{sid}")
        client.delete(f"/subjects/{empty}")
        db.ex("DELETE FROM jobs")


def test_example_subject_has_its_questions():
    sid = client.post("/examples/physics").json()["id"]
    try:
        subj = next(s for s in client.get("/subjects").json() if s["id"] == sid)
        assert subj["questions"] == examples.QUESTIONS
        assert questions.ensure(sid) is None
    finally:
        client.delete(f"/subjects/{sid}")
        db.ex("DELETE FROM jobs")
