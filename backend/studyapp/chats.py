"""Chats: list, create (one blank chat at most), rename, delete (soft, undoable) and restore, usage stats, the
context meter, and the background title. Messages and replies are in chat_reply.py."""
import json
import logging
import re
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import db, jobs, llm
from .chat_prompt import HISTORY_TOKENS, _history, _system_prompt, _tokens
from .parsers import approx_tokens

log = logging.getLogger(__name__)

router = APIRouter()


def _chat(cid):
    c = db.q1("SELECT * FROM chats WHERE id=?", (cid,))
    if c is None:
        raise HTTPException(404, "Chat not found")
    return c


def _msg_out(m):
    m = dict(m)
    m["meta"] = json.loads(m["meta"] or "{}")
    for f in m["meta"].get("files", []):
        f.pop("text", None)
    aid = m["meta"].get("artifact_id")
    if aid:
        a = db.q1("SELECT id, type, title, status, progress, message, error FROM artifacts WHERE id=? AND deleted_at IS NULL", (aid,))
        m["artifact"] = a
    return m


def _add_message(cid, role, content="", meta=None):
    mid = db.ex("INSERT INTO messages(chat_id, role, content, meta, created_at) VALUES (?,?,?,?,?)",
                (cid, role, content, json.dumps(meta or {}), time.time()))
    db.ex("UPDATE chats SET updated_at=? WHERE id=?", (time.time(), cid))
    return _msg_out(db.q1("SELECT * FROM messages WHERE id=?", (mid,)))


class NewChat(BaseModel):
    topic_id: int | None = None


@router.get("/subjects/{sid}/chats")
def list_chats(sid: int):
    return db.q("SELECT * FROM chats WHERE subject_id=? AND deleted_at IS NULL ORDER BY updated_at DESC", (sid,))


@router.post("/subjects/{sid}/chats")
def create_chat(sid: int, body: NewChat):
    """A new chat, or the subject's existing empty one: there's never more than one blank chat (double clicks, both
    "+" buttons)."""
    if not db.q1("SELECT id FROM subjects WHERE id=?", (sid,)):
        raise HTTPException(404, "Subject not found")
    now = time.time()
    with db.tx() as c:
        empty = c.execute("""SELECT id FROM chats c WHERE subject_id=? AND deleted_at IS NULL
                             AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=c.id)
                             ORDER BY updated_at DESC LIMIT 1""", (sid,)).fetchone()
        if empty:
            cid = empty[0]
            c.execute("UPDATE chats SET topic_id=?, updated_at=? WHERE id=?", (body.topic_id, now, cid))
            # blank chats left over from before this rule: nothing in them, so they simply go
            c.execute("""DELETE FROM chats WHERE subject_id=? AND id<>? AND deleted_at IS NULL
                         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_id=chats.id)""", (sid, cid))
        else:
            cid = c.execute("INSERT INTO chats(subject_id, topic_id, created_at, updated_at) VALUES (?,?,?,?)",
                            (sid, body.topic_id, now, now)).lastrowid
    return db.q1("SELECT * FROM chats WHERE id=?", (cid,))


class ChatIds(BaseModel):
    ids: list[int]


def _soft_delete(ids: list[int]):
    now = time.time()
    with db.tx() as c:
        for cid in ids:
            c.execute("UPDATE chats SET deleted_at=? WHERE id=? AND deleted_at IS NULL", (now, cid))
            c.execute("UPDATE jobs SET cancel=1 WHERE type='chat' AND ref_id=? AND status='running'", (cid,))


@router.post("/chats/delete")
def delete_chats(body: ChatIds):
    """Delete several chats (soft: /chats/restore brings them back; purged a week later)."""
    _soft_delete(body.ids)
    return {"ok": True}


@router.post("/chats/restore")
def restore_chats(body: ChatIds):
    with db.tx() as c:
        for cid in body.ids:
            c.execute("UPDATE chats SET deleted_at=NULL WHERE id=?", (cid,))
    return {"ok": True}


def purge_deleted_chats(days: float = 7):
    db.ex("DELETE FROM chats WHERE deleted_at IS NOT NULL AND deleted_at < ?", (time.time() - days * 86400,))


@router.post("/chats/{cid}/stop")
def stop_chat(cid: int):
    """Stop the reply being written in this chat (what's been written so far is kept)."""
    db.ex("UPDATE jobs SET cancel=1 WHERE type='chat' AND ref_id=? AND status='running'", (cid,))
    return {"ok": True}


@router.get("/chats/{cid}/stats")
def chat_stats(cid: int, scope: str = "chat"):
    """Totals for /stats: this chat, the chat's subject, or every chat. Replies written before usage was recorded
    count as replies but not towards tokens/time ('uncounted')."""
    chat = _chat(cid)
    if scope == "subject":
        where, args = "c.subject_id=?", (chat["subject_id"],)
    elif scope == "all":
        where, args = "1=1", ()
    else:
        scope, where, args = "chat", "c.id=?", (cid,)
    rows = db.q(f"""SELECT m.role, m.meta FROM messages m JOIN chats c ON c.id=m.chat_id
                    WHERE {where} AND c.deleted_at IS NULL AND m.role IN ('user','assistant')""", args)
    out = {"scope": scope, "chats": db.q1(f"SELECT COUNT(*) n FROM chats c WHERE {where} AND deleted_at IS NULL", args)["n"],
           "questions": 0, "replies": 0, "uncounted": 0, "stopped": 0, "prompt": 0, "completion": 0, "reasoning": 0,
           "seconds": 0.0, "reasoning_seconds": 0.0, "cost": 0.0, "local_replies": 0, "online_replies": 0, "models": []}
    models = set()
    for r in rows:
        if r["role"] == "user":
            out["questions"] += 1
            continue
        out["replies"] += 1
        meta = json.loads(r["meta"] or "{}")
        out["stopped"] += bool(meta.get("stopped"))
        out["reasoning_seconds"] += meta.get("reasoning_seconds") or 0
        u = meta.get("usage")
        if not u:
            out["uncounted"] += 1
            continue
        for k in ("prompt", "completion", "reasoning"):
            out[k] += int(u.get(k) or 0)
        out["seconds"] += float(u.get("seconds") or 0)
        out["cost"] += float(u.get("cost") or 0)
        out["online_replies" if u.get("provider") == "openrouter" else "local_replies"] += 1
        if u.get("model"):
            models.add(u["model"])
    out["models"] = sorted(models)
    out["seconds"] = round(out["seconds"], 1)
    out["reasoning_seconds"] = round(out["reasoning_seconds"], 1)
    out["cost"] = round(out["cost"], 6)
    return out


@router.get("/chats/{cid}/context")
def chat_context(cid: int):
    """How full the context window is for this chat's next question. `exact`: the last reply's server-reported prompt
    + completion; the breakdown is always estimated from text length."""
    chat = _chat(cid)
    system, full = _system_prompt(chat)
    head, sep, rest = system.partition("=== STUDY MATERIAL ===")
    material = approx_tokens(rest) if sep else 0
    rules = approx_tokens(head)
    history = sum(_tokens(m["content"]) for m in _history(cid)) if db.q1(
        "SELECT 1 FROM messages WHERE chat_id=? LIMIT 1", (cid,)) else 0
    estimate = rules + material + history
    # the server's own count from the latest reply that has one (a stopped reply has none); it includes the
    # excerpts added to each question, which the estimate can't know
    real, latest = None, True
    for m in db.q("SELECT meta FROM messages WHERE chat_id=? AND role='assistant' ORDER BY id DESC LIMIT 20", (cid,)):
        u = json.loads(m["meta"] or "{}").get("usage") or {}
        if u.get("prompt"):
            real = u.get("last_prompt", u["prompt"]) + u.get("last_completion", u.get("completion", 0))
            break
        latest = False
    total = max(real or 0, estimate)
    # the whole conversation, against the share of it Apollo is sent (_history keeps only the latest turns within
    # HISTORY_TOKENS): past that, the earliest messages are left out, usually long before the window itself fills
    convo = sum(_tokens(m["content"]) for m in db.q(
        "SELECT content FROM messages WHERE chat_id=? AND role IN ('user','assistant')", (cid,)))
    return {"limit": llm.context_tokens(), "system": rules, "material": material, "history": history,
            "total": total, "estimate": estimate, "exact": real is not None and latest and real >= estimate, "full_context": full,
            "conversation": convo, "history_limit": HISTORY_TOKENS}


class ChatPatch(BaseModel):
    title: str | None = None
    topic_id: int | None = None
    set_topic: bool = False  # topic_id may legitimately be null (= all topics)


@router.patch("/chats/{cid}")
def patch_chat(cid: int, body: ChatPatch):
    _chat(cid)
    if body.title is not None:
        db.ex("UPDATE chats SET title=? WHERE id=?", (body.title.strip() or "New chat", cid))
    if body.set_topic:
        db.ex("UPDATE chats SET topic_id=? WHERE id=?", (body.topic_id, cid))
    return db.q1("SELECT * FROM chats WHERE id=?", (cid,))


@router.delete("/chats/{cid}")
def delete_chat(cid: int):
    _soft_delete([cid])
    return {"ok": True}


@router.get("/chats/{cid}")
def get_chat(cid: int):
    c = _chat(cid)
    c["messages"] = [_msg_out(m) for m in db.q("SELECT * FROM messages WHERE chat_id=? ORDER BY id", (cid,))]
    return c


TITLE_PROMPT = ("Give this study conversation a short title: 3-6 words, Title Case, naming the topic itself (e.g. "
                "'Snell's Law Refraction Problems', 'SQL Joins vs Subqueries'). No quotes, no trailing full stop, no "
                "words like 'Question about' or 'Help with'. Reply with the title only.")


def _clean_title(raw: str) -> str:
    t = llm.strip_think(raw).splitlines()
    t = t[0] if t else ""
    t = re.sub(r"^(title|chat title)\s*:\s*", "", t, flags=re.I).strip(" \t\"'“”‘’*#`.")
    return t[:60].strip()


def auto_title(cid: int, force: bool = False) -> str | None:
    """Name a chat from its first exchange. Only replaces the placeholder title (the first question cut to 60
    characters) unless `force`, so a chat the student renamed keeps its name."""
    chat = db.q1("SELECT * FROM chats WHERE id=?", (cid,))
    if not chat:
        return None
    msgs = db.q("SELECT role, content FROM messages WHERE chat_id=? AND role IN ('user','assistant') ORDER BY id LIMIT 4", (cid,))
    first = next((m["content"] for m in msgs if m["role"] == "user"), "")
    answer = next((m["content"] for m in msgs if m["role"] == "assistant"), "")
    if not first or (not force and chat["title"] not in ("New chat", first.strip()[:60])):
        return None
    with jobs.track("chat", "Naming the chat", "Choosing a title") as tracked:
        try:
            res = llm.chat([{"role": "system", "content": TITLE_PROMPT},
                            {"role": "user", "content": f"Student: {first[:1500]}\n\nApollo: {answer[:1500]}"}],
                           max_tokens=40, reasoning="off", temperature=0.2)
        except Exception as e:
            tracked.fail(str(e))
            if force:  # asked for from the menu: say why (e.g. the model is paused)
                raise HTTPException(409, str(e))
            return None
    title = _clean_title(res["content"])
    if not title:
        return None
    now = db.q1("SELECT title FROM chats WHERE id=?", (cid,))
    if not force and (not now or now["title"] != chat["title"]):  # renamed meanwhile
        return None
    db.ex("UPDATE chats SET title=? WHERE id=?", (title, cid))
    return title


def _title_later(cid: int):
    """Name the chat after its first reply, off the request thread (the reply has already been sent)."""
    import threading

    def run():
        try:
            auto_title(cid)
        except Exception:
            log.info("couldn't name chat %s", cid, exc_info=True)
    threading.Thread(target=run, daemon=True, name=f"title-{cid}").start()


@router.post("/chats/{cid}/auto-title")
def retitle_chat(cid: int):
    _chat(cid)
    title = auto_title(cid, force=True)
    if not title:
        raise HTTPException(409, "Apollo couldn't name this chat yet (it needs a question and a reply).")
    return db.q1("SELECT * FROM chats WHERE id=?", (cid,))
