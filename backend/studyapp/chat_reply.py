"""One chat turn: the student's message (with attachments, files sent for this message only, or a quoted
highlight) and Apollo's streamed reply, plus edit, rollback and regenerate."""
import base64
import hashlib
import json
import logging
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import citations, config, context, db, errors, figures, generate, jobs, llm, pipeline
from .chat_files import _read_chat_file
from .chat_prompt import (ATTACHED_RULES, DEFAULT_RULES, QUOTE_RULES, SEARCH_TOOL, _attachment_material, _history,
                          _other_topic_docs, _system_prompt)

log = logging.getLogger(__name__)
from .chats import _add_message, _chat, _msg_out, _title_later
from .chat_tools import READ_TOOLS, TOOL_SPECS, _read_tool, _review_message, _todo_message, _tool_message

router = APIRouter()


class Quote(BaseModel):
    """Text the student highlighted in a document, with the sentence before and after it."""
    document_id: int | None = None
    filename: str
    label: str = ""
    text: str
    before: str = ""
    after: str = ""


class Ask(BaseModel):
    content: str
    reasoning: str = "off"  # off | low | medium | xhigh
    attachments: list[int] = []  # document ids dragged into the chat
    files: list[str] = []  # paths of files sent straight to the chat (read now, not ingested)
    quote: Quote | None = None


@router.get("/chat/default-prompt")
def default_prompt():
    return {"prompt": DEFAULT_RULES}


class InspectBody(BaseModel):
    paths: list[str]


@router.post("/chat-files/inspect")
def inspect_chat_files(body: InspectBody):
    """Check files before they're attached, so size errors show straight away."""
    out = []
    for p in body.paths:
        try:
            f = _read_chat_file(p)
            out.append({"path": p, "name": f["name"], "kind": f["kind"], "words": f.get("words"), "source": f.get("source"), "ok": True})
        except HTTPException as e:
            out.append({"path": p, "name": Path(p).name, "ok": False, "error": e.detail})
    return out


class ImageBody(BaseModel):
    png: str  # base64 PNG: a screenshot of part of the app's own page (generated notes, a cheat sheet, a mind map)
    name: str = "screenshot"


@router.post("/chat-files/image")
def save_chat_image(body: ImageBody):
    """Keep a screenshot taken in the app (Electron captures the area) as a file the chat can attach, in the data
    folder (always readable, see grants)."""
    try:
        png = base64.b64decode(body.png, validate=True)
    except ValueError:
        raise HTTPException(400, "Not an image")
    if not png.startswith(b"\x89PNG") or len(png) > 20_000_000:
        raise HTTPException(400, "Not a PNG screenshot")
    stem = re.sub(r'[<>:"/\\|?*]+', " ", body.name).strip()[:60] or "screenshot"
    out = config.assets_dir() / "chat" / f"{stem} {hashlib.sha256(png).hexdigest()[:6]}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)
    return {"path": str(out.resolve()), "name": out.name}


def _create_user_message(chat, content: str, attachments: list[int], files: list[dict], quote: dict | None):
    attached = []
    for did in dict.fromkeys(attachments):
        d = db.q1("SELECT id, filename FROM documents WHERE id=? AND subject_id=?", (did, chat["subject_id"]))
        if d:
            attached.append(d)
    meta = {}
    if files:
        meta["files"] = files
    if attached:
        meta["attachments"] = [{"id": d["id"], "filename": d["filename"]} for d in attached]
    if quote and str(quote.get("text", "")).strip():
        meta["quote"] = quote
    msg = _add_message(chat["id"], "user", content.strip(), meta)
    if chat["title"] == "New chat":
        db.ex("UPDATE chats SET title=? WHERE id=?", (content.strip()[:60], chat["id"]))
    return msg


def _respond(cid: int, user_msg: dict, reasoning: str, announce_user: bool):
    """Stream Qwen's reply to a stored user message (a new one, an edited one, or one being regenerated).
    Attachments, files and the highlighted passage all come from the message itself."""
    chat = _chat(cid)
    umeta = user_msg["meta"]
    attached = [d for a in umeta.get("attachments", []) if (d := db.q1(
        "SELECT d.*, t.name AS topic_name FROM documents d LEFT JOIN topics t ON t.id=d.topic_id WHERE d.id=?", (a["id"],)))]
    files = umeta.get("files", [])
    quote = umeta.get("quote")
    others = _other_topic_docs(chat)
    tools = TOOL_SPECS + ([SEARCH_TOOL] if others else [])

    def events():
        def ev(obj):
            return f"data: {json.dumps(obj)}\n\n"
        if announce_user:
            yield ev({"type": "user", "message": user_msg})
        # shown in the jobs list while Apollo replies (and can be stopped from there)
        with jobs.track("chat", chat["title"] if chat["title"] != "New chat" else user_msg["content"][:60],
                        "Reading your material", ref_id=cid) as tracked:
            yield from reply(tracked, ev)
        yield ev({"type": "end"})
        if db.setting("chat_auto_title") and db.q1(
                "SELECT COUNT(*) n FROM messages WHERE chat_id=? AND role='assistant'", (cid,))["n"] == 1:
            _title_later(cid)

    # What has been written so far lives here, so a stop can still save it.
    st = {"prefix": "", "content": "", "reasoning_text": "", "r_start": None, "r_end": None, "searched": [],
          "usage": {}, "started": time.time(), "level": "off"}

    def meta():
        secs = round((st["r_end"] or time.time()) - st["r_start"], 1) if st["r_start"] else None
        out = {"reasoning": st["reasoning_text"], "reasoning_seconds": secs, "reasoning_level": st["level"]}
        if st["searched"]:
            out["searched_other_topics"] = st["searched"]
        cfg = llm.llm_cfg()
        out["usage"] = {**st["usage"], "seconds": round(time.time() - st["started"], 1), "model": cfg["model"],
                        "provider": "openrouter" if cfg["online"] else "local"}
        return out

    def reply(tracked, ev):
        try:
            system, full = _system_prompt(chat)
            hist = _history(cid)
            query = user_msg["content"] + (f"\n{quote['text']}" if quote else "")
            extra = ""
            if attached:
                extra += "\n\n" + _attachment_material(chat, attached, query, full)
            if attached or files:
                extra += "\n\n" + ATTACHED_RULES
            if quote:
                extra += "\n\n" + QUOTE_RULES
            if not full:
                extra += "\n\n[Relevant excerpts from the study material]\n" + context.retrieved_material(chat["subject_id"], chat["topic_id"], query)
            tb = "" if context.uses_reference_material(chat["subject_id"], chat["topic_id"]) else context.textbook_passages(chat["subject_id"], query, k=4)
            if tb:
                extra += "\n\n[Relevant textbook passages, authoritative reference]\n" + tb
            if extra:
                last = hist[-1]["content"]
                hist[-1] = {"role": "user", "content": last + extra if isinstance(last, str)
                            else [{"type": "text", "text": last[0]["text"] + extra}, *last[1:]]}
            if llm.gate_busy():  # a background job is mid-call; chat goes next (llm._Gate), but that call has to end
                yield ev({"type": "status", "text": "Waiting for Apollo to finish a background task"})
                tracked.update("Waiting for a background task")
                while llm.gate_busy():  # waited here, not in the gate, so Stop works while waiting
                    if tracked.cancelled():
                        raise pipeline.Cancelled()
                    time.sleep(0.3)
                tracked.update("Reading your material")
            yield ev({"type": "status", "text": "Reading your material"})
            convo =[{"role": "system", "content": system}, *hist]
            level = reasoning if reasoning in ("low", "medium", "xhigh") else "off"
            st["level"] = level

            content = ""
            for round_ in range(3):  # each search of other topics feeds back in; at most two per turn
                content, searches = "", []
                st["content"] = ""
                for kind, data in llm.chat_stream(convo, tools=tools, max_tokens=6000 if level == "off" else 16000,
                                                  reasoning=level, cancelled=tracked.cancelled):
                    if tracked.cancelled():  # Stop in the chat, or Cancel in the jobs list
                        raise pipeline.Cancelled()
                    if kind == "reasoning" and not st["reasoning_text"]:
                        tracked.update("Thinking")
                    elif kind == "content" and not content:
                        tracked.update("Writing the reply")
                    if kind == "content":
                        if st["r_start"] and not st["r_end"]:
                            st["r_end"] = time.time()
                        content += data
                        st["content"] = content
                        yield ev({"type": "delta", "text": data})
                    elif kind == "reasoning":
                        st["r_start"] = st["r_start"] or time.time()
                        st["reasoning_text"] += data
                        yield ev({"type": "reasoning", "text": data})
                    elif kind == "usage":
                        _add_usage(st["usage"], data)
                    elif kind == "tool_calls":
                        if st["r_start"] and not st["r_end"]:
                            st["r_end"] = time.time()
                        searches = [c for c in data if c["name"] in READ_TOOLS]
                        if len(searches) < len(data) and (st["prefix"] + content).strip():
                            yield ev({"type": "assistant", "message": _add_message(cid, "assistant", (st["prefix"] + content).strip(), meta())})
                            st["usage"] = {}  # counted on that message
                            st["prefix"] = content = st["content"] = ""
                        for call in data:
                            if call["name"] in generate.TOOLS:
                                yield ev({"type": "tool", "message": _tool_message(chat, call["name"], call["arguments"])})
                            elif call["name"] == "add_todos":
                                yield ev({"type": "tool", "message": _todo_message(chat, call["arguments"])})
                            elif call["name"] == "review_content":
                                yield ev({"type": "tool", "message": _review_message(chat, call["arguments"])})
                if not searches or round_ == 2:
                    break
                calls, results = [], []
                for k, s in enumerate(searches):
                    if s["name"] == "search_other_topics":
                        st["searched"].append(str((s["arguments"] or {}).get("query") or user_msg["content"]))
                    status, result = _read_tool(chat, s, others, user_msg["content"])
                    yield ev({"type": "status", "text": status})
                    tracked.update(status)
                    call_id = s.get("id") or f"call_{round_}_{k}"
                    calls.append({"id": call_id, "type": "function",
                                  "function": {"name": s["name"], "arguments": json.dumps(s["arguments"] or {})}})
                    results.append({"role": "tool", "tool_call_id": call_id, "content": result})
                convo += [{"role": "assistant", "content": content, "tool_calls": calls}, *results]
                if content.strip():
                    st["prefix"] += content.strip() + "\n\n"
                    yield ev({"type": "delta", "text": "\n\n"})
                st["content"] = ""
            final = (st["prefix"] + content).strip()
            if final:
                # each citation checked against the text it supports; a clearly wrong slide/page is moved (citations.py)
                try:
                    final, _ = citations.verify(final, chat["subject_id"])
                except Exception:  # never lose a reply over the check
                    log.warning("citation check failed", exc_info=True)
                # Figures Apollo asked for are cropped from the student's material now (the model call is over, so
                # the vision check can use the connection).
                found = {}
                for tag in list(dict.fromkeys(m.group(0) for m in figures.FIGURE_TAG.finditer(final)))[:3]:
                    yield ev({"type": "status", "text": "Finding the figure in your material"})
                    tracked.update("Finding a figure in your material")
                    found.update(figures.resolve(chat["subject_id"], tag, limit=1))
                m = meta()
                if found:
                    m["figures"] = found
                yield ev({"type": "assistant", "message": _add_message(cid, "assistant", final, m)})
        except (pipeline.Cancelled, llm.StreamCancelled):
            tracked.stop()
            # keep what was written before the stop
            partial = (st["prefix"] + st["content"]).strip()
            if partial:
                m = meta()
                m["stopped"] = True
                yield ev({"type": "assistant", "message": _add_message(cid, "assistant", partial, m)})
            yield ev({"type": "stopped"})
        except Exception as e:
            err = errors.classify(e, "llm")
            log.warning("%s chat %s reply failed: %s", err.code, cid, err.technical or err.plain, exc_info=err.code == "APO-APP-900")
            tracked.fail(str(err))
            yield ev({"type": "error", "text": str(err), "code": err.code})

    return StreamingResponse(events(), media_type="text/event-stream")


def _add_usage(total: dict, u: dict):
    """Sum token counts over the model calls of one reply (a search of other topics makes another call)."""
    for k in ("prompt", "completion", "reasoning"):
        total[k] = total.get(k, 0) + int(u.get(k) or 0)
    total["last_prompt"] = int(u.get("prompt") or 0)  # what the context held on the last call
    total["last_completion"] = int(u.get("completion") or 0)
    if u.get("cost") is not None:
        total["cost"] = round(total.get("cost", 0) + float(u["cost"]), 6)


@router.post("/chats/{cid}/messages")
def ask(cid: int, body: Ask):
    chat = _chat(cid)
    if not body.content.strip():
        raise HTTPException(400, "Empty message")
    files = [_read_chat_file(p) for p in dict.fromkeys(body.files)]
    msg = _create_user_message(chat, body.content, body.attachments, files, body.quote.model_dump() if body.quote else None)
    return _respond(cid, msg, body.reasoning, announce_user=True)


def _message(mid: int):
    m = db.q1("SELECT * FROM messages WHERE id=?", (mid,))
    if m is None:
        raise HTTPException(404, "Message not found")
    return m


class EditBody(BaseModel):
    content: str
    reasoning: str = "off"


@router.post("/messages/{mid}/edit")
def edit_message(mid: int, body: EditBody):
    """Rewrite a question: everything from it onwards is removed and Qwen answers the new wording. Its highlighted
    passage, attached files and library attachments are kept."""
    m = _message(mid)
    if m["role"] != "user":
        raise HTTPException(400, "Only your own messages can be edited")
    if not body.content.strip():
        raise HTTPException(400, "Empty message")
    meta = json.loads(m["meta"] or "{}")
    db.ex("DELETE FROM messages WHERE chat_id=? AND id>=?", (m["chat_id"], mid))
    new = _add_message(m["chat_id"], "user", body.content.strip(), meta)
    return _respond(m["chat_id"], new, body.reasoning, announce_user=True)


@router.post("/messages/{mid}/rollback")
def rollback(mid: int):
    """Undo the conversation back to before this message (it and everything after it are removed). Generated content
    stays in the library. Returns the removed message so its text can go back into the composer."""
    m = _message(mid)
    db.ex("DELETE FROM messages WHERE chat_id=? AND id>=?", (m["chat_id"], mid))
    db.ex("UPDATE chats SET updated_at=? WHERE id=?", (time.time(), m["chat_id"]))
    return _msg_out(m)


class RegenBody(BaseModel):
    reasoning: str = "off"


@router.post("/messages/{mid}/regenerate")
def regenerate(mid: int, body: RegenBody):
    """A new reply to the question this reply answered; this reply and everything after it are replaced."""
    m = _message(mid)
    if m["role"] == "user":
        raise HTTPException(400, "Pick one of Apollo's replies")
    u = db.q1("SELECT * FROM messages WHERE chat_id=? AND role='user' AND id<? ORDER BY id DESC LIMIT 1", (m["chat_id"], mid))
    if u is None:
        raise HTTPException(400, "Nothing to answer")
    db.ex("DELETE FROM messages WHERE chat_id=? AND id>?", (m["chat_id"], u["id"]))
    return _respond(m["chat_id"], _msg_out(u), body.reasoning, announce_user=False)
