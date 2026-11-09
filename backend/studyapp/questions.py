"""Three example questions per subject, shown as the study sheet's chat-bar placeholder.

Made once by Apollo when a subject first has a ready file (a `questions` job in the generate lane, ref_id = subject),
stored in `subjects.questions` (a JSON list) and never updated. Subjects from before this existed get theirs at the
next start-up (`ensure_all`). A failed attempt leaves the column empty, so it is tried again at the next start-up or
the next file that finishes reading.
"""
import json
import logging

from pydantic import BaseModel, Field

from . import db, jobs, llm

log = logging.getLogger(__name__)

BUDGET = 5000  # tokens of material sampled from the subject's files


class Questions(BaseModel):
    questions: list[str] = Field(min_length=3, max_length=3)


def _ready(subject_id: int) -> bool:
    return db.q1("SELECT 1 FROM documents WHERE subject_id=? AND kind<>'trash' AND status IN ('ready','vision') "
                 "AND chunk_count > 0 LIMIT 1", (subject_id,)) is not None


def ensure(subject_id: int) -> int | None:
    """Queue the subject's questions if it has none yet and a file is ready. Returns the job id, if queued."""
    s = db.q1("SELECT name, questions FROM subjects WHERE id=?", (subject_id,))
    if not s or s["questions"] or not _ready(subject_id):
        return None
    return jobs.enqueue("questions", ref_id=subject_id, label=s["name"])


def ensure_all() -> int:
    """Start-up: every subject that still has no questions and has material."""
    return sum(1 for s in db.q("SELECT id FROM subjects WHERE questions IS NULL") if ensure(s["id"]))


def _sample(subject_id: int) -> str:
    """Passages spread over every ready file (a few from each, evenly spaced), within BUDGET tokens."""
    docs = db.q("SELECT id, filename FROM documents WHERE subject_id=? AND kind<>'trash' AND status IN ('ready','vision') "
                "ORDER BY kind='reference', id", (subject_id,))
    if not docs:
        return ""
    per_doc = max(1, BUDGET // len(docs))
    out, used = [], 0
    for d in docs:
        chunks = db.q("SELECT text, token_count FROM chunks WHERE document_id=? AND source<>'vision' ORDER BY id",
                      (d["id"],))
        if not chunks:
            continue
        step = max(1, len(chunks) // 4)
        took = 0
        for c in chunks[::step]:
            if took >= per_doc or used >= BUDGET:
                break
            text = c["text"][: per_doc * 4]
            out.append(f"[From {d['filename']}]\n{text}")
            took += min(c["token_count"], per_doc)
            used += min(c["token_count"], per_doc)
    return "\n\n".join(out)


def run(subject_id: int, job) -> list[str] | None:
    s = db.q1("SELECT name, questions FROM subjects WHERE id=?", (subject_id,))
    if not s or s["questions"]:
        return None
    topics = [t["name"] for t in db.q("SELECT name FROM topics WHERE subject_id=? ORDER BY position IS NULL, position, name",
                                      (subject_id,))]
    material = _sample(subject_id)
    if not material:
        return None
    job.note("Thinking of example questions")
    task = (f"A student is studying the subject \"{s['name']}\""
            + (f" (topics: {', '.join(topics)})" if topics else "")
            + ". Below are passages from their study material.\n\n"
            "Write exactly 3 short, specific questions this student might ask a tutor about this material: each one "
            "answerable from it, under 80 characters, phrased as the student would type it, and each about a different "
            "part of the material. No numbering.\n\n" + material)
    res = llm.chat_json([{"role": "user", "content": task}], Questions, max_tokens=600, temperature=0.7, reasoning="off")
    qs = [q.strip().strip('"').strip() for q in res.questions if q.strip()][:3]
    if len(qs) < 3:
        return None
    db.ex("UPDATE subjects SET questions=? WHERE id=? AND questions IS NULL", (json.dumps(qs), subject_id))
    return qs
