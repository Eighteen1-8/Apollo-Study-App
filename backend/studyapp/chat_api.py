"""Chat with Qwen about a subject (optionally scoped to one topic). Content creation happens through tool calls:
the model (or a quick-action button) creates a 'tool' message holding a form; submitting it starts a generation job.
Routes are split: chats.py (the chats themselves), chat_reply.py (messages and Apollo's replies) and this
module (content forms and the content they create); `router` serves them all."""
import json
import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import context, db, generate, grants, jobs, marking

from . import chat_reply, chats
from .chat_tools import READ_TOOLS, TOOL_SPECS, _read_tool, _tool_message  # noqa: F401 (re-exported)
from .chats import _add_message, _chat, _clean_title, _msg_out, auto_title, purge_deleted_chats  # noqa: F401 (re-exported)
from .chat_files import _read_chat_file

log = logging.getLogger(__name__)

router = APIRouter()
router.include_router(chats.router)
router.include_router(chat_reply.router)


# ---------------------------------------------------------------- tool forms -> artifacts

class ToolBody(BaseModel):
    tool: str
    args: dict = {}


@router.post("/chats/{cid}/tool")
def open_tool(cid: int, body: ToolBody):
    """Quick action: open a create-content form without asking the model."""
    chat = _chat(cid)
    if body.tool not in generate.TOOLS:
        raise HTTPException(400, "Unknown tool")
    return _tool_message(chat, body.tool, body.args)


class Submit(BaseModel):
    args: dict
    topic_id: int | None = None


@router.post("/messages/{mid}/submit")
def submit_tool(mid: int, body: Submit):
    m = db.q1("SELECT * FROM messages WHERE id=?", (mid,))
    if m is None or m["role"] != "tool":
        raise HTTPException(404, "Form not found")
    meta = json.loads(m["meta"])
    if meta.get("status") != "form":
        raise HTTPException(400, "Already submitted")
    chat = _chat(m["chat_id"])
    kind = meta["type"]
    args = dict(body.args)
    if kind == "exam":
        if args.get("difficulty") not in ("easy", "normal", "hard"):
            raise HTTPException(400, "Choose a difficulty")
        if not args.get("practice_exam_path") or not grants.require(args["practice_exam_path"]).is_file():
            raise HTTPException(400, "[APO-GEN-402] Upload a practice exam")
    if kind == "quiz":
        args = _quiz_args(args)
    # chosen pages of one or more files (a chat tool call like "slides 10-20 of Lecture 3"): those files are the scope
    units = _checked_units(chat["subject_id"], _unit_keys(args.pop("units", None) or {}))
    args.pop("file", None)
    args.pop("pages", None)
    topic_id = None if units else body.topic_id
    doc_ids = sorted(units) if units else None
    problem = context.material_problem(chat["subject_id"], topic_id, doc_ids, units)
    if problem:  # say so on the form instead of failing in the queue
        raise HTTPException(400, f"[APO-GEN-401] {problem}")
    if units:
        args["document_ids"] = doc_ids
        args["units"] = {str(k): v for k, v in units.items()}
    where = _units_where(units) if units else context.scope_label(chat["subject_id"], topic_id).split(' › ')[-1]
    title = f"{generate.TYPE_TITLES[kind]}: {where}" + (f" ({args['difficulty'].title()})" if kind == "exam" else "")
    now = time.time()
    aid = db.ex("""INSERT INTO artifacts(subject_id, topic_id, chat_id, type, title, params, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (chat["subject_id"], topic_id, chat["id"], kind, title, json.dumps(args), "queued", now, now))
    jobs.enqueue("generate", ref_id=aid)
    meta.update(status="submitted", args=args, artifact_id=aid, topic_id=topic_id)
    db.ex("UPDATE messages SET meta=?, content=? WHERE id=?", (json.dumps(meta), title, mid))
    return _msg_out(db.q1("SELECT * FROM messages WHERE id=?", (mid,)))


class CreateBody(BaseModel):
    type: str
    topic_id: int | None = None
    document_ids: list[int] = []
    args: dict = {}
    extra_paths: list[str] = []
    instructions: str = ""
    units: dict[int, list[int]] = {}  # chosen pages/slides: {doc_id: [unit idx, ...]}


EXTRA_WORD_LIMIT = 15000


def _checked_units(sid: int, units: dict[int, list[int]]) -> dict[int, list[int]] | None:
    """The chosen pages/slides, each file's list checked against its units (so a stale choice says so)."""
    out = {}
    for did, idxs in units.items():
        d = db.q1("SELECT id, filename FROM documents WHERE id=? AND subject_id=? AND kind<>'trash'", (did, sid))
        if d is None:
            raise HTTPException(404, "File not found")
        want = sorted(set(idxs))
        if not want:
            raise HTTPException(400, f"[APO-GEN-401] Choose at least one page or slide of {d['filename']}, or clear the choice.")
        have = {r["idx"] for r in db.q(f"SELECT idx FROM units WHERE document_id=? AND idx IN ({','.join('?' * len(want))})", (did, *want))}
        if have != set(want):
            raise HTTPException(400, f"[APO-GEN-401] Some of the chosen pages aren't in {d['filename']} "
                                     f"({context.ranges_text(sorted(set(want) - have))}). Choose them again.")
        out[did] = want
    return out or None


def _unit_keys(units) -> dict[int, list[int]]:
    """A JSON choice of pages ({"12": [3, 4]}) with int keys; anything malformed is refused plainly."""
    if not isinstance(units, dict):
        raise HTTPException(400, "[APO-GEN-401] The chosen pages couldn't be read. Choose them again.")
    try:
        return {int(k): [int(i) for i in v] for k, v in units.items()}
    except (TypeError, ValueError):
        raise HTTPException(400, "[APO-GEN-401] The chosen pages couldn't be read. Choose them again.")


def _units_where(units: dict[int, list[int]]) -> str:
    """The title's "where" for chosen pages: "lecture 3 (slides 3–7)" for one file, else "N files"."""
    if len(units) != 1:
        return f"{len(units)} files"
    (did, idxs), = units.items()
    d = db.q1("SELECT filename FROM documents WHERE id=?", (did,))
    kind = (db.q1("SELECT kind FROM units WHERE document_id=? AND idx=?", (did, idxs[0])) or {}).get("kind") or "page"
    return f"{d['filename'].rsplit('.', 1)[0]} ({kind}{'s' if len(idxs) > 1 else ''} {context.ranges_text(idxs)})"


def _quiz_args(args: dict) -> dict:
    """A quiz's options, checked: difficulty (easy | normal | hard) and question types (generate.QUIZ_TYPES)."""
    out = dict(args)
    if out.get("difficulty") in (None, ""):
        out.pop("difficulty", None)
    elif out["difficulty"] not in generate.QUIZ_DIFFICULTY:
        raise HTTPException(400, "Choose easy, normal or hard.")
    if out.get("types") is not None:
        types = [t for t in out["types"] if t in generate.QUIZ_TYPES] if isinstance(out["types"], list) else []
        if not types:
            raise HTTPException(400, "Choose at least one kind of question.")
        out["types"] = [t for t in generate.QUIZ_TYPES if t in types]
    return out


@router.post("/subjects/{sid}/artifacts")
def create_artifact(sid: int, body: CreateBody):
    """Make content straight from the Make content steps (no chat form). Scope: the whole subject, one topic, or
    `document_ids` (files of this subject), optionally narrowed to chosen pages/slides (`units`, kept in params).
    `extra_paths` are files the student added for this request only: read now (not ingested; the paths need grants)
    and kept in the artifact's params with the `instructions` for them. Marking (`type='marking'`) copies the work
    and rubric files instead (marking.py) and may have no material at all (`args.against='nothing'`)."""
    if body.type not in generate.TYPE_TITLES:
        raise HTTPException(400, "Unknown content type")
    if db.q1("SELECT id FROM subjects WHERE id=?", (sid,)) is None:
        raise HTTPException(404, "Subject not found")
    args = dict(body.args)
    if body.type == "exam":
        if args.get("difficulty") not in ("easy", "normal", "hard"):
            raise HTTPException(400, "Choose a difficulty")
        if not args.get("practice_exam_path") or not grants.require(args["practice_exam_path"]).is_file():
            raise HTTPException(400, "[APO-GEN-402] Upload a practice exam")
    if body.type == "quiz":
        args = _quiz_args(args)
    marking_files = marking.checked_files(args) if body.type == "marking" else None
    no_material = body.type == "marking" and args.get("against") == "nothing"
    doc_ids = sorted(set(body.document_ids))
    docs = []
    if doc_ids:
        docs = db.q(f"SELECT id, filename FROM documents WHERE subject_id=? AND kind<>'trash' AND id IN ({','.join('?' * len(doc_ids))})",
                    (sid, *doc_ids))
        if len(docs) != len(doc_ids):
            raise HTTPException(404, "File not found")
    if body.topic_id is not None and db.q1("SELECT id FROM topics WHERE id=? AND subject_id=?", (body.topic_id, sid)) is None:
        raise HTTPException(404, "Topic not found")
    units = None if no_material else _checked_units(sid, body.units)
    topic_id = None if doc_ids else body.topic_id
    if units:
        in_scope = {d["id"] for d in context.topic_documents(sid, topic_id, doc_ids or None, units)}
        if in_scope != set(units):
            raise HTTPException(400, "[APO-GEN-401] Some of the chosen pages are in files outside the material you picked. "
                                     "Choose the pages again.")
    problem = None if no_material else context.material_problem(sid, topic_id, doc_ids or None, units)
    if problem:
        raise HTTPException(400, f"[APO-GEN-401] {problem}")
    extra, words = [], 0
    for p in ([] if body.type == "marking" else body.extra_paths):
        f = _read_chat_file(p)
        if f["kind"] != "text":
            raise HTTPException(400, f"[APO-FILE-308] {f['name']}: pictures can't be used as extra material yet. Add a PDF or Word file instead.")
        words += f["words"]
        if words > EXTRA_WORD_LIMIT:
            raise HTTPException(413, f"[APO-FILE-307] The extra material is too long together (the limit is {EXTRA_WORD_LIMIT:,} words). "
                                     "Add fewer files, or add them to a topic so they're read properly.")
        extra.append({"name": f["name"], "text": f["text"]})
    if extra:
        args["extra"] = extra
    if body.instructions.strip():
        args["instructions"] = body.instructions.strip()[:2000]
    if doc_ids and not no_material:
        args["document_ids"] = doc_ids
    if units:
        args["units"] = {str(k): v for k, v in units.items()}
    if body.type == "marking":
        args = marking.params(args, marking_files)
        title = marking.title(marking_files)
    else:
        where = (docs[0]["filename"].rsplit(".", 1)[0] if len(docs) == 1 else f"{len(docs)} files") if docs             else context.scope_label(sid, body.topic_id).split(" › ")[-1]
        if units and len(units) == 1:  # "Quiz: lecture 3 (slides 3–7)"
            where = _units_where(units)
        title = f"{generate.TYPE_TITLES[body.type]}: {where}" + (f" ({args['difficulty'].title()})" if body.type == "exam" else "")
    now = time.time()
    aid = db.ex("""INSERT INTO artifacts(subject_id, topic_id, chat_id, type, title, params, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (sid, None if doc_ids or no_material else body.topic_id, None, body.type, title, json.dumps(args), "queued", now, now))
    if body.type == "marking":
        try:
            args = marking.store_files(aid, args, marking_files)
        except Exception:
            db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
            marking.remove_files(aid)
            raise
        db.ex("UPDATE artifacts SET params=? WHERE id=?", (json.dumps(args), aid))
    jobs.enqueue("generate", ref_id=aid)
    return {"id": aid, "type": body.type, "title": title, "status": "queued"}


@router.post("/messages/{mid}/dismiss")
def dismiss_tool(mid: int):
    m = db.q1("SELECT * FROM messages WHERE id=?", (mid,))
    if m is None:
        raise HTTPException(404)
    meta = json.loads(m["meta"])
    if meta.get("status") == "form":
        meta["status"] = "dismissed"
        db.ex("UPDATE messages SET meta=? WHERE id=?", (json.dumps(meta), mid))
    return _msg_out(db.q1("SELECT * FROM messages WHERE id=?", (mid,)))


@router.get("/artifacts/{aid}/summary")
def artifact_summary(aid: int):
    """Just its state (no content): what a chat's progress card follows, also after a later Regenerate."""
    a = db.q1("SELECT id, type, title, status, progress, message, error FROM artifacts WHERE id=? AND deleted_at IS NULL", (aid,))
    if a is None:
        raise HTTPException(404)
    return a


@router.get("/artifacts/{aid}")
def get_artifact(aid: int):
    a = db.q1("SELECT * FROM artifacts WHERE id=? AND deleted_at IS NULL", (aid,))
    if a is None:
        raise HTTPException(404)
    a["params"] = json.loads(a["params"])
    a["content"] = json.loads(a["content"]) if a["content"] else None
    a["resumable"] = bool(a.pop("partial", None))  # finished parts are saved: Retry continues from them
    a["attempts"] = db.q("SELECT id, kind, status, score, total, created_at FROM attempts WHERE artifact_id=? ORDER BY id DESC", (aid,))
    a["ratings"] = {r["card_index"]: r["rating"] for r in db.q("SELECT card_index, rating FROM card_ratings WHERE artifact_id=?", (aid,))}
    return a


@router.post("/artifacts/{aid}/retry")
def retry_artifact(aid: int, fresh: bool | None = None):
    """Regenerate / Retry. Deleted content stays deleted; content already being made keeps its job (no second one).
    After a failure or cancel it continues from the parts already finished (generate.Partial); Regenerate on ready
    content starts over (or `fresh=true` forces a fresh start)."""
    a = db.q1("SELECT * FROM artifacts WHERE id=? AND deleted_at IS NULL", (aid,))
    if a is None:
        raise HTTPException(404, "That content was deleted.")
    waiting = db.q1("SELECT id FROM jobs WHERE type='generate' AND ref_id=? AND status IN ('queued','running')", (aid,))
    if waiting:
        return {"job_id": waiting["id"]}
    if fresh is None:
        fresh = a["status"] == "ready"
    db.ex("UPDATE artifacts SET status='queued', error=NULL, progress=0, message='', updated_at=?"
          + (", partial=NULL" if fresh else "") + " WHERE id=?", (time.time(), aid))
    return {"job_id": jobs.enqueue("generate", ref_id=aid)}


class NewVersionBody(BaseModel):
    work_paths: list[str]
    rubric_path: str | None = None  # a different marking guide; none: the previous one's
    drop_rubric: bool = False       # mark this version without the previous marking guide
    out_of: float | None = None     # left out: as before
    instructions: str | None = None  # left out: as before; "" removes them


@router.post("/artifacts/{aid}/new-version")
def new_marking_version(aid: int, body: NewVersionBody):
    """Mark a new version of the same work (Marking view): new work files with the previous marking's rubric,
    instructions, out-of and material unless changed. The result links back (params.previous) and compares."""
    prev = db.q1("SELECT * FROM artifacts WHERE id=? AND type='marking' AND deleted_at IS NULL", (aid,))
    if prev is None:
        raise HTTPException(404, "That marking was deleted.")
    params, files, title = marking.new_version(prev, body.model_dump(exclude_unset=True))
    now = time.time()
    nid = db.ex("""INSERT INTO artifacts(subject_id, topic_id, chat_id, type, title, params, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (prev["subject_id"], prev["topic_id"], None, "marking", title, json.dumps(params), "queued", now, now))
    try:
        params = marking.store_files(nid, params, files)
    except Exception:
        db.ex("DELETE FROM artifacts WHERE id=?", (nid,))
        marking.remove_files(nid)
        raise
    db.ex("UPDATE artifacts SET params=? WHERE id=?", (json.dumps(params), nid))
    jobs.enqueue("generate", ref_id=nid)
    return {"id": nid, "type": "marking", "title": title, "status": "queued"}


@router.post("/artifacts/{aid}/cancel")
def cancel_artifact(aid: int):
    for j in db.q("SELECT id FROM jobs WHERE type='generate' AND ref_id=? AND status IN ('queued','running')", (aid,)):
        jobs.cancel(j["id"])
    db.ex("UPDATE artifacts SET status='cancelled' WHERE id=? AND status='queued'", (aid,))
    return {"ok": True}


@router.get("/subjects/{sid}/artifacts")
def list_artifacts(sid: int):
    return db.q("SELECT id, topic_id, type, title, status, created_at FROM artifacts WHERE subject_id=? AND deleted_at IS NULL "
                "ORDER BY id DESC", (sid,))


class AttemptBody(BaseModel):
    answers: dict[str, str]


@router.post("/artifacts/{aid}/attempts")
def submit_attempt(aid: int, body: AttemptBody):
    a = db.q1("SELECT * FROM artifacts WHERE id=? AND type='exam' AND status='ready'", (aid,))
    if a is None:
        raise HTTPException(404, "Exam not ready")
    now = time.time()
    att = db.ex("INSERT INTO attempts(artifact_id, answers, status, created_at, updated_at) VALUES (?,?,?,?,?)",
                (aid, json.dumps(body.answers), "marking", now, now))
    jobs.enqueue("mark", ref_id=att)
    return get_attempt(att)


@router.get("/attempts/{att}")
def get_attempt(att: int):
    r = db.q1("SELECT * FROM attempts WHERE id=?", (att,))
    if r is None:
        raise HTTPException(404)
    r["answers"] = json.loads(r["answers"])
    r["result"] = json.loads(r["result"]) if r["result"] else None
    return r
