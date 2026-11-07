"""Chat with Qwen about a subject (optionally scoped to one topic). Content creation happens through tool calls:
the model (or a quick-action button) creates a 'tool' message holding a form; submitting it starts a generation job.
Routes are split: chats.py (the chats themselves), chat_reply.py (messages and Apollo's replies) and this
module (content forms and the content they create); `router` serves them all."""
import json
import logging
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import context, db, generate, grants, jobs

from . import chat_reply, chats
from .chat_tools import READ_TOOLS, TOOL_SPECS, _read_tool, _tool_message  # noqa: F401 (re-exported)
from .chats import _add_message, _chat, _clean_title, _msg_out, auto_title, purge_deleted_chats  # noqa: F401 (re-exported)

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
            raise HTTPException(400, "Upload a practice exam")
    problem = context.material_problem(chat["subject_id"], body.topic_id)
    if problem:  # say so on the form instead of failing in the queue
        raise HTTPException(400, problem)
    scope = context.scope_label(chat["subject_id"], body.topic_id)
    title = f"{generate.TYPE_TITLES[kind]}: {scope.split(' › ')[-1]}" + (f" ({args['difficulty'].title()})" if kind == "exam" else "")
    now = time.time()
    aid = db.ex("""INSERT INTO artifacts(subject_id, topic_id, chat_id, type, title, params, status, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (chat["subject_id"], body.topic_id, chat["id"], kind, title, json.dumps(args), "queued", now, now))
    jobs.enqueue("generate", ref_id=aid)
    meta.update(status="submitted", args=args, artifact_id=aid, topic_id=body.topic_id)
    db.ex("UPDATE messages SET meta=?, content=? WHERE id=?", (json.dumps(meta), title, mid))
    return _msg_out(db.q1("SELECT * FROM messages WHERE id=?", (mid,)))


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


@router.get("/artifacts/{aid}")
def get_artifact(aid: int):
    a = db.q1("SELECT * FROM artifacts WHERE id=? AND deleted_at IS NULL", (aid,))
    if a is None:
        raise HTTPException(404)
    a["params"] = json.loads(a["params"])
    a["content"] = json.loads(a["content"]) if a["content"] else None
    a["attempts"] = db.q("SELECT id, kind, status, score, total, created_at FROM attempts WHERE artifact_id=? ORDER BY id DESC", (aid,))
    a["ratings"] = {r["card_index"]: r["rating"] for r in db.q("SELECT card_index, rating FROM card_ratings WHERE artifact_id=?", (aid,))}
    return a


@router.post("/artifacts/{aid}/retry")
def retry_artifact(aid: int):
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (aid,))
    if a is None:
        raise HTTPException(404)
    db.ex("UPDATE artifacts SET status='queued', error=NULL, progress=0, message='' WHERE id=?", (aid,))
    return {"job_id": jobs.enqueue("generate", ref_id=aid)}


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
