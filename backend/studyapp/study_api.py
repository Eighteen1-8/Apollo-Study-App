"""Study features around generated content: subject icons, revision to-dos, flashcard ratings, quiz review,
and managing the saved content library."""
import json
import shutil
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, db, llm
from .parsers import IMAGE_EXTS

router = APIRouter()


def _subject(sid):
    s = db.q1("SELECT * FROM subjects WHERE id=?", (sid,))
    if s is None:
        raise HTTPException(404, "Subject not found")
    return s


# ---------------------------------------------------------------- subject icon

class IconBody(BaseModel):
    color: str | None = None
    icon_text: str | None = None
    icon_emoji: str | None = None
    clear_image: bool = False
    image_path: str | None = None  # local file chosen by the user; copied into the app's assets


@router.patch("/subjects/{sid}/icon")
def set_icon(sid: int, body: IconBody):
    s = _subject(sid)
    fields = {}
    if body.color is not None:
        fields["color"] = body.color
    if body.icon_text is not None:
        fields["icon_text"] = body.icon_text.strip()[:3] or None
        fields["icon_emoji"] = None
    if body.icon_emoji is not None:
        fields["icon_emoji"] = body.icon_emoji.strip()[:8] or None
    if body.image_path:
        src = Path(body.image_path)
        if not src.is_file() or src.suffix.lower() not in IMAGE_EXTS:
            raise HTTPException(400, "Choose a PNG, JPG, WEBP, BMP or GIF image")
        folder = config.assets_dir() / "subject_icons"
        folder.mkdir(parents=True, exist_ok=True)
        rel = f"subject_icons/{sid}_{int(time.time())}{src.suffix.lower()}"
        shutil.copyfile(src, config.assets_dir() / rel)
        fields["icon_image"] = rel
    if body.clear_image or body.icon_text is not None or body.icon_emoji is not None:
        if s["icon_image"] and not body.image_path:
            (config.assets_dir() / s["icon_image"]).unlink(missing_ok=True)
            fields["icon_image"] = None
    if fields:
        db.ex(f"UPDATE subjects SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), sid))
    return db.q1("SELECT * FROM subjects WHERE id=?", (sid,))


@router.get("/subjects/{sid}/all-documents")
def all_documents(sid: int):
    """Every document in the subject (topic material and textbooks): used to resolve citations to files."""
    return db.q("""SELECT d.id, d.filename, d.kind, d.topic_id, d.ext, t.name AS topic_name FROM documents d
                   LEFT JOIN topics t ON t.id=d.topic_id WHERE d.subject_id=? ORDER BY d.id""", (sid,))


# ---------------------------------------------------------------- file folders (display only)

@router.get("/subjects/{sid}/folders")
def get_folders(sid: int):
    """Folders inside topics, grouping files in the sidebar. Stored for the UI as-is; nothing else reads them."""
    r = db.q1("SELECT value FROM ui_state WHERE key=?", (f"folders:{sid}",))
    return json.loads(r["value"]) if r else {}


@router.put("/subjects/{sid}/folders")
def put_folders(sid: int, body: dict):
    _subject(sid)
    db.ex("INSERT OR REPLACE INTO ui_state(key, value) VALUES (?, ?)", (f"folders:{sid}", json.dumps(body)))
    return body


# ---------------------------------------------------------------- generated content library

@router.get("/subjects/{sid}/library")
def library(sid: int):
    rows = db.q("""SELECT a.id, a.topic_id, a.chat_id, a.type, a.title, a.status, a.progress, a.message, a.created_at,
                          t.name AS topic_name FROM artifacts a LEFT JOIN topics t ON t.id=a.topic_id
                   WHERE a.subject_id=? AND a.status != 'cancelled' ORDER BY a.id DESC""", (sid,))
    return rows


class ArtifactPatch(BaseModel):
    title: str


@router.patch("/artifacts/{aid}")
def rename_artifact(aid: int, body: ArtifactPatch):
    db.ex("UPDATE artifacts SET title=? WHERE id=?", (body.title.strip() or "Untitled", aid))
    return {"ok": True}


@router.delete("/artifacts/{aid}")
def delete_artifact(aid: int):
    for j in db.q("SELECT id FROM jobs WHERE type='generate' AND ref_id=? AND status IN ('queued','running')", (aid,)):
        db.ex("UPDATE jobs SET cancel=1 WHERE id=?", (j["id"],))
    db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
    return {"ok": True}


# ---------------------------------------------------------------- flashcard ratings

class Rating(BaseModel):
    rating: str  # confident | struggling | none


@router.put("/artifacts/{aid}/cards/{idx}/rating")
def rate_card(aid: int, idx: int, body: Rating):
    if body.rating == "none":
        db.ex("DELETE FROM card_ratings WHERE artifact_id=? AND card_index=?", (aid, idx))
    elif body.rating in ("confident", "struggling"):
        db.ex("INSERT OR REPLACE INTO card_ratings(artifact_id, card_index, rating, updated_at) VALUES (?,?,?,?)",
              (aid, idx, body.rating, time.time()))
    else:
        raise HTTPException(400, "rating must be confident, struggling or none")
    return {"ok": True}


class CardIndices(BaseModel):
    indices: list[int]


@router.post("/artifacts/{aid}/cards/delete")
def delete_cards(aid: int, body: CardIndices):
    """Remove flashcards from a deck. Ratings are keyed by card index, so the remaining ones are renumbered."""
    a = db.q1("SELECT content FROM artifacts WHERE id=? AND type='flashcards'", (aid,))
    if a is None:
        raise HTTPException(404, "Flashcard deck not found")
    content = json.loads(a["content"] or "{}")
    cards = content.get("cards", [])
    drop = {i for i in body.indices if 0 <= i < len(cards)}
    remap = {}
    for i in range(len(cards)):
        if i not in drop:
            remap[i] = len(remap)
    content["cards"] = [c for i, c in enumerate(cards) if i not in drop]
    with db.tx() as c:
        c.execute("UPDATE artifacts SET content=? WHERE id=?", (json.dumps(content), aid))
        rows = c.execute("SELECT card_index, rating, updated_at FROM card_ratings WHERE artifact_id=?", (aid,)).fetchall()
        c.execute("DELETE FROM card_ratings WHERE artifact_id=?", (aid,))
        for r in rows:
            if r["card_index"] in remap:
                c.execute("INSERT INTO card_ratings(artifact_id, card_index, rating, updated_at) VALUES (?,?,?,?)",
                          (aid, remap[r["card_index"]], r["rating"], r["updated_at"]))
    return {"ok": True, "count": len(content["cards"])}


def struggling_cards(subject_id: int, topic_id: int | None, limit=20) -> list[dict]:
    """Flashcards the student marked 'I need more revision on this', newest first, within the scope."""
    sql = """SELECT a.content, a.topic_id, r.card_index FROM card_ratings r JOIN artifacts a ON a.id=r.artifact_id
             WHERE a.subject_id=? AND r.rating='struggling'"""
    args = [subject_id]
    if topic_id is not None:
        sql += " AND (a.topic_id=? OR a.topic_id IS NULL)"
        args.append(topic_id)
    out = []
    for r in db.q(sql + " ORDER BY r.updated_at DESC LIMIT ?", (*args, limit)):
        cards = (json.loads(r["content"] or "{}")).get("cards", [])
        if r["card_index"] < len(cards):
            out.append(cards[r["card_index"]])
    return out


# ---------------------------------------------------------------- quiz review

class QuizAnswers(BaseModel):
    answers: dict[str, int]  # question index -> chosen option index


class Revise(BaseModel):
    topic: str
    reason: str
    source: str = ""


class Review(BaseModel):
    summary: str
    strengths: list[str] = []
    revise: list[Revise] = []


@router.post("/artifacts/{aid}/quiz-review")
def quiz_review(aid: int, body: QuizAnswers):
    a = db.q1("SELECT * FROM artifacts WHERE id=? AND type='quiz' AND status='ready'", (aid,))
    if a is None:
        raise HTTPException(404, "Quiz not found")
    qs = json.loads(a["content"])["questions"]
    lines, score = [], 0
    for i, q in enumerate(qs):
        pick = body.answers.get(str(i))
        ok = pick == q["answer_index"]
        score += ok
        chosen = q["options"][pick] if pick is not None and 0 <= pick < len(q["options"]) else "(no answer)"
        lines.append(f"Q{i + 1}: {q['question']}\n  Student chose: {chosen} -> {'CORRECT' if ok else 'WRONG'}\n"
                     f"  Correct answer: {q['options'][q['answer_index']]}\n  Source: {q.get('source', '')}")
    task = ("You are a supportive tutor reviewing a student's quiz. Below are each question, the student's answer, whether it "
            "was right and the source in their notes.\nWrite a short summary of how they did, list what they clearly understand, "
            "and list the specific topics they most likely need to revise (based on wrong answers and patterns across them). "
            "Each revise item: a short topic name a student would put on a to-do list, why, and the source to revise from. "
            "If everything was right, suggest at most one stretch topic.\n\n" + "\n\n".join(lines))
    review = llm.chat_json([{"role": "user", "content": task}], Review, max_tokens=8000,
                           reasoning=db.setting("review_reasoning"), temperature=0.3)
    now = time.time()
    att = db.ex("""INSERT INTO attempts(artifact_id, kind, answers, status, result, score, total, progress, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,1,?,?)""",
                (aid, "quiz", json.dumps(body.answers), "marked", review.model_dump_json(), score, len(qs), now, now))
    return {"attempt_id": att, "score": score, "total": len(qs), **review.model_dump()}


# ---------------------------------------------------------------- revision to-dos

class TodoBody(BaseModel):
    text: str
    note: str = ""
    topic_id: int | None = None
    source: str = "manual"


class TodoPatch(BaseModel):
    text: str | None = None
    done: bool | None = None


@router.get("/subjects/{sid}/todos")
def list_todos(sid: int):
    return db.q("""SELECT td.*, t.name AS topic_name FROM todos td LEFT JOIN topics t ON t.id=td.topic_id
                   WHERE td.subject_id=? ORDER BY td.done, td.id DESC""", (sid,))


@router.post("/subjects/{sid}/todos")
def add_todo(sid: int, body: TodoBody):
    _subject(sid)
    if not body.text.strip():
        raise HTTPException(400, "Empty to-do")
    existing = db.q1("SELECT id FROM todos WHERE subject_id=? AND text=? AND done=0", (sid, body.text.strip()))
    if existing:
        return db.q1("SELECT * FROM todos WHERE id=?", (existing["id"],))
    tid = db.ex("INSERT INTO todos(subject_id, topic_id, text, note, source, created_at) VALUES (?,?,?,?,?,?)",
                (sid, body.topic_id, body.text.strip(), body.note, body.source, time.time()))
    return db.q1("SELECT * FROM todos WHERE id=?", (tid,))


@router.patch("/todos/{tid}")
def patch_todo(tid: int, body: TodoPatch):
    if body.text is not None:
        db.ex("UPDATE todos SET text=? WHERE id=?", (body.text.strip(), tid))
    if body.done is not None:
        db.ex("UPDATE todos SET done=? WHERE id=?", (int(body.done), tid))
    return db.q1("SELECT * FROM todos WHERE id=?", (tid,))


@router.delete("/todos/{tid}")
def delete_todo(tid: int):
    db.ex("DELETE FROM todos WHERE id=?", (tid,))
    return {"ok": True}
