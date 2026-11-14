"""Study features around generated content: subject icons, revision to-dos, flashcard ratings, quiz review,
and managing the saved content library."""
import json
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, db, grants, jobs, llm
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
    icon_name: str | None = None  # a subject-art key from the picker (app/src/components/subjectIcons.ts)
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
        fields["icon_name"] = None
    if body.icon_emoji is not None:
        fields["icon_emoji"] = body.icon_emoji.strip()[:8] or None
    if body.icon_name is not None:
        fields["icon_name"] = body.icon_name.strip()[:40] or None
        fields["icon_emoji"] = None
        fields["icon_text"] = None
    if body.image_path:
        src = grants.require(body.image_path)
        if not src.is_file() or src.suffix.lower() not in IMAGE_EXTS:
            raise HTTPException(400, "Choose a PNG, JPG, WEBP, BMP or GIF image")
        folder = config.assets_dir() / "subject_icons"
        folder.mkdir(parents=True, exist_ok=True)
        rel = f"subject_icons/{sid}_{int(time.time())}{src.suffix.lower()}"
        config.copy_atomic(src, config.assets_dir() / rel)
        fields["icon_image"] = rel
    if body.clear_image or body.icon_text is not None or body.icon_emoji is not None or body.icon_name is not None:
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
                   LEFT JOIN topics t ON t.id=d.topic_id WHERE d.subject_id=? AND d.kind<>'trash' ORDER BY d.id""", (sid,))


# ---------------------------------------------------------------- file folders (sidebar grouping only)
# Folders group a topic's files in the sidebar; nothing else (search, context, generation) reads them. Each change
# writes only its own rows, so changes never overwrite each other and each can be undone on its own.

@router.get("/subjects/{sid}/folders")
def get_folders(sid: int):
    """{topic id: {folders: [{id, name}], files: {doc id: folder id}, ordered}}. Folders come in the student's
    order when they have dragged them (`ordered`), otherwise the UI sorts them by name. Ids are strings."""
    out: dict = {}
    for f in db.q("SELECT id, topic_id, name, position FROM folders WHERE subject_id=? "
                  "ORDER BY position IS NULL, position, id", (sid,)):
        t = out.setdefault(str(f["topic_id"]), {"folders": [], "files": {}, "ordered": False})
        t["folders"].append({"id": str(f["id"]), "name": f["name"]})
        t["ordered"] = t["ordered"] or f["position"] is not None
    for d in db.q("SELECT d.id, d.folder_id, f.topic_id FROM documents d JOIN folders f ON f.id=d.folder_id "
                  "WHERE f.subject_id=?", (sid,)):
        out[str(d["topic_id"])]["files"][str(d["id"])] = str(d["folder_id"])
    return out


class FolderBody(BaseModel):
    topic_id: int
    name: str
    doc_ids: list[int] = []


class FolderPatch(BaseModel):
    name: str


class FolderOrder(BaseModel):
    ids: list[int]


class FolderPlace(BaseModel):
    doc_ids: list[int]
    folder_id: int | None = None


def _folder(fid: int) -> dict:
    f = db.q1("SELECT * FROM folders WHERE id=?", (fid,))
    if not f:
        raise HTTPException(404, "Folder not found")
    return f


def _place(c, doc_ids: list[int], folder: dict | None):
    """Put files in `folder` (None: in no folder). Only files of the folder's topic can go in."""
    for d in doc_ids:
        if folder is None:
            c.execute("UPDATE documents SET folder_id=NULL WHERE id=?", (d,))
        else:
            c.execute("UPDATE documents SET folder_id=? WHERE id=? AND kind='topic' AND topic_id=?",
                      (folder["id"], d, folder["topic_id"]))


@router.post("/subjects/{sid}/folders")
def create_folder(sid: int, body: FolderBody):
    _subject(sid)
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    if not db.q1("SELECT 1 FROM topics WHERE id=? AND subject_id=?", (body.topic_id, sid)):
        raise HTTPException(400, "That topic isn't in this subject")
    with db.tx() as c:
        # in a topic whose folders were dragged into an order, a new folder goes last
        last = c.execute("SELECT MAX(position) FROM folders WHERE topic_id=?", (body.topic_id,)).fetchone()[0]
        fid = c.execute("INSERT INTO folders(subject_id, topic_id, name, position, created_at) VALUES (?,?,?,?,?)",
                        (sid, body.topic_id, body.name.strip(), None if last is None else last + 1, time.time())).lastrowid
        _place(c, body.doc_ids, {"id": fid, "topic_id": body.topic_id})
    return {"id": str(fid)}


@router.patch("/folders/{fid}")
def rename_folder(fid: int, body: FolderPatch):
    _folder(fid)
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    db.ex("UPDATE folders SET name=? WHERE id=?", (body.name.strip(), fid))
    return {"ok": True}


@router.delete("/folders/{fid}")
def delete_folder(fid: int):
    """The folder goes; its files stay in the topic."""
    f = _folder(fid)
    with db.tx() as c:
        c.execute("UPDATE documents SET folder_id=NULL WHERE folder_id=?", (fid,))
        c.execute("DELETE FROM folders WHERE id=?", (fid,))
    return {"ok": True, "topic_id": f["topic_id"]}


@router.put("/folders/place")
def place_files(body: FolderPlace):
    folder = _folder(body.folder_id) if body.folder_id is not None else None
    with db.tx() as c:
        _place(c, body.doc_ids, folder)
    return {"ok": True}


@router.put("/topics/{tid}/folders/order")
def order_folders(tid: int, body: FolderOrder):
    """The topic's folders in this order; any not listed (made since) follow."""
    with db.tx() as c:
        ids = [r[0] for r in c.execute("SELECT id FROM folders WHERE topic_id=? ORDER BY position IS NULL, position, id",
                                       (tid,)).fetchall()]
        order = [i for i in body.ids if i in ids] + [i for i in ids if i not in body.ids]
        for pos, fid in enumerate(order):
            c.execute("UPDATE folders SET position=? WHERE id=?", (pos, fid))
    return {"ok": True}


# ---------------------------------------------------------------- generated content library

@router.get("/subjects/{sid}/library")
def library(sid: int):
    rows = db.q("""SELECT a.id, a.topic_id, a.chat_id, a.type, a.title, a.status, a.progress, a.message, a.error, a.created_at,
                          t.name AS topic_name FROM artifacts a LEFT JOIN topics t ON t.id=a.topic_id
                   WHERE a.subject_id=? AND a.status != 'cancelled' AND a.deleted_at IS NULL
                   ORDER BY date(a.created_at, 'unixepoch', 'localtime') DESC, a.position IS NULL, a.position, a.id DESC""", (sid,))
    return rows


class IdOrder(BaseModel):
    ids: list[int]


@router.put("/subjects/{sid}/artifacts/order")
def order_artifacts(sid: int, body: IdOrder):
    """The order the student dragged generated content into. The UI only moves an item among those made the same
    day, so the list's dates stay in order."""
    with db.tx() as c:
        for i, aid in enumerate(body.ids):
            c.execute("UPDATE artifacts SET position=? WHERE id=? AND subject_id=?", (i, aid, sid))
    return {"ok": True}


class ArtifactPatch(BaseModel):
    title: str


@router.patch("/artifacts/{aid}")
def rename_artifact(aid: int, body: ArtifactPatch):
    db.ex("UPDATE artifacts SET title=? WHERE id=?", (body.title.strip() or "Untitled", aid))
    return {"ok": True}


@router.delete("/artifacts/{aid}")
def delete_artifact(aid: int):
    """Soft delete: hidden everywhere at once, restorable (POST /artifacts/{id}/restore) until purged after a week.
    Generation still running for it stops (a restored one that was unfinished can be retried)."""
    for j in db.q("SELECT id FROM jobs WHERE type='generate' AND ref_id=? AND status IN ('queued','running')", (aid,)):
        db.ex("UPDATE jobs SET cancel=1 WHERE id=?", (j["id"],))
    db.ex("UPDATE artifacts SET deleted_at=? WHERE id=? AND deleted_at IS NULL", (time.time(), aid))
    return {"ok": True}


@router.post("/artifacts/{aid}/restore")
def restore_artifact(aid: int):
    """Undo a delete. Content that was still being made when it was deleted (deleting stopped it, leaving it
    'cancelled', which the library doesn't list) is queued again, so it comes back as it was: on its way."""
    db.ex("UPDATE artifacts SET deleted_at=NULL WHERE id=?", (aid,))
    a = db.q1("SELECT status, content FROM artifacts WHERE id=?", (aid,))
    if a and not a["content"] and a["status"] in ("queued", "running", "cancelled"):
        # the job being stopped for the deleted one is told to stop; a new one is queued behind it
        db.ex("UPDATE jobs SET status='cancelled', updated_at=? WHERE type='generate' AND ref_id=? AND status='queued'",
              (time.time(), aid))
        if not db.q1("SELECT 1 FROM jobs WHERE type='generate' AND ref_id=? AND status='running'", (aid,)):
            db.ex("UPDATE artifacts SET status='queued', error=NULL, progress=0, message='' WHERE id=?", (aid,))
            jobs.enqueue("generate", ref_id=aid)
    return {"ok": True}


def purge_deleted(days: float = 7):
    """Delete for good the generated content and notes deleted more than `days` ago (at start-up)."""
    cutoff = time.time() - days * 86400
    with db.tx() as c:
        c.execute("DELETE FROM reviews WHERE target='note' AND target_id IN "
                  "(SELECT id FROM user_notes WHERE deleted_at IS NOT NULL AND deleted_at < ?)", (cutoff,))
        c.execute("DELETE FROM user_notes WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))
        c.execute("DELETE FROM artifacts WHERE deleted_at IS NOT NULL AND deleted_at < ?", (cutoff,))


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
    sql = """SELECT a.content, a.topic_id, r.card_index FROM card_ratings r JOIN artifacts a ON a.id=r.artifact_id AND a.deleted_at IS NULL
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
    with jobs.track("quiz_review", f"Review: {a['title']}", "Reviewing your answers"):
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
                   WHERE td.subject_id=? ORDER BY td.done, td.position IS NULL, td.position, td.id DESC""", (sid,))


@router.put("/subjects/{sid}/todos/order")
def order_todos(sid: int, body: IdOrder):
    with db.tx() as c:
        for i, tid in enumerate(body.ids):
            c.execute("UPDATE todos SET position=? WHERE id=? AND subject_id=?", (i, tid, sid))
    return {"ok": True}


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
    if body.text is not None and body.text.strip():
        db.ex("UPDATE todos SET text=? WHERE id=?", (body.text.strip(), tid))
    if body.done is not None:
        db.ex("UPDATE todos SET done=? WHERE id=?", (int(body.done), tid))
    return db.q1("SELECT * FROM todos WHERE id=?", (tid,))


@router.delete("/todos/{tid}")
def delete_todo(tid: int):
    db.ex("DELETE FROM todos WHERE id=?", (tid,))
    return {"ok": True}


# ---------------------------------------------------------------- command palette (Ctrl+K)

@router.get("/palette")
def palette():
    """Everything the command palette can jump to, across all subjects, in one call (titles and ids only)."""
    return {
        "subjects": db.q("SELECT id, name FROM subjects ORDER BY position IS NULL, position, name COLLATE NOCASE"),
        "topics": db.q("SELECT id, subject_id, name FROM topics ORDER BY position IS NULL, position, name COLLATE NOCASE"),
        "documents": db.q("SELECT id, subject_id, topic_id, kind, filename FROM documents WHERE kind<>'trash' ORDER BY id DESC"),
        "artifacts": db.q("""SELECT id, subject_id, topic_id, type, title FROM artifacts
                             WHERE status='ready' AND deleted_at IS NULL ORDER BY id DESC"""),
        "notes": db.q("SELECT id, subject_id, topic_id, title FROM user_notes WHERE deleted_at IS NULL ORDER BY updated_at DESC"),
        "chats": db.q("""SELECT id, subject_id, topic_id, title, updated_at FROM chats WHERE deleted_at IS NULL
                         AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=chats.id) ORDER BY updated_at DESC LIMIT 400"""),
    }
