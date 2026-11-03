"""Chat with Qwen about a subject (optionally scoped to one topic). Content creation happens through tool calls:
the model (or a quick-action button) creates a 'tool' message holding a form; submitting it starts a generation job."""
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

from . import config, context, db, figures, generate, grants, jobs, llm, notes_api, pipeline, review, search, study_api
from .chat_files import _read_chat_file
from .chat_prompt import (ATTACHED_RULES, DEFAULT_RULES, QUOTE_RULES, SEARCH_TOOL, _attachment_material, _history,
                          _other_topic_docs, _system_prompt)

log = logging.getLogger(__name__)

router = APIRouter()

TOOL_SPECS = [
    {"type": "function", "function": {"name": "create_flashcards", "description":
        "Create a set of flashcards from the student's material for the selected topic scope.",
        "parameters": {"type": "object", "properties": {
            "count": {"type": "integer", "description": "number of cards, default 20"},
            "focus": {"type": "string", "description": "optional sub-area to focus on"}}}}},
    {"type": "function", "function": {"name": "create_quiz", "description":
        "Create a short multiple-choice quiz with explanations from the student's material.",
        "parameters": {"type": "object", "properties": {
            "count": {"type": "integer", "description": "number of questions, default 10"},
            "focus": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "create_exam", "description":
        "Create a full exam modelled on a practice exam the student uploads (same structure, new questions), marked by the tutor.",
        "parameters": {"type": "object", "properties": {
            "difficulty": {"type": "string", "enum": ["easy", "normal", "hard"]}}}}},
    {"type": "function", "function": {"name": "create_notes", "description":
        "Compile comprehensive structured study notes from all the material in scope.",
        "parameters": {"type": "object", "properties": {"focus": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "create_cheatsheet", "description":
        "Create a one-page cheat sheet of key definitions and formulas.",
        "parameters": {"type": "object", "properties": {"focus": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "create_mindmap", "description":
        "Create a mind map showing how the ideas in the student's material connect.",
        "parameters": {"type": "object", "properties": {"focus": {"type": "string"}}}}},
    {"type": "function", "function": {"name": "view_todos", "description":
        "Read the student's revision to-do list (what's done and what's still to do). Use it when the student asks "
        "about their to-dos, what to revise next, or their progress, or before planning their revision.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "list_content", "description":
        "List the student's own notes and the generated notes and cheat sheets in this subject, by title.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "read_content", "description":
        "Read one of the student's notes or a generated notes / cheat sheet (see list_content) to answer questions about it.",
        "parameters": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}}},
    {"type": "function", "function": {"name": "review_content", "description":
        "Check whether one of the student's notes or a generated notes / cheat sheet is correct (mode 'check'), or "
        "change it as the student asks (mode 'revise': add, fix, shorten, reorganise...). Runs in the background; the "
        "student sees the result on the note and decides whether to apply a revision.",
        "parameters": {"type": "object", "properties": {
            "title": {"type": "string", "description": "the title, as in list_content"},
            "mode": {"type": "string", "enum": ["check", "revise"]},
            "instruction": {"type": "string", "description": "for revise: what to change, in the student's terms"}},
            "required": ["title", "mode"]}}},
    {"type": "function", "function": {"name": "add_todos", "description":
        "Add items to the student's revision to-do list (shown beside the chat). Use when the student asks you to plan "
        "their revision, set them tasks, or add/remember to-dos. Keep each item short and actionable.",
        "parameters": {"type": "object", "properties": {
            "items": {"type": "array", "items": {"type": "object", "properties": {
                "text": {"type": "string", "description": "the task, e.g. 'Practise voltage divider questions'"},
                "note": {"type": "string", "description": "optional detail, e.g. which pages to revise"}},
                "required": ["text"]}},
            "topic": {"type": "string", "description": "optional topic name the items belong to"}},
            "required": ["items"]}}},
]


READ_TOOLS = ("search_other_topics", "view_todos", "list_content", "read_content")


def _read_tool(chat, call, others: list[int], fallback_query: str) -> tuple[str, str]:
    """(status shown to the student, result for the model) for a tool that only reads."""
    args = call["arguments"] if isinstance(call["arguments"], dict) else {}
    name = call["name"]
    if name == "search_other_topics":
        q = str(args.get("query") or fallback_query)
        try:
            hits = context._format_hits(search.search(q, others, k=8))
        except Exception as e:  # e.g. embeddings offline
            hits = f"(search failed: {e})"
        return f"Searching your other topics for “{q[:60]}”", f"[Material from the student's other topics]\n{hits or '(nothing relevant found)'}"
    if name == "view_todos":
        todos = study_api.list_todos(chat["subject_id"])
        if not todos:
            return "Reading your to-do list", "(The to-do list is empty.)"
        lines = [f"- [{'x' if t['done'] else ' '}] {t['text']}" + (f" ({t['topic_name']})" if t["topic_name"] else "")
                 + (f": {t['note']}" if t["note"] else "") for t in todos]
        return "Reading your to-do list", "[The student's revision to-do list; [x] = done]\n" + "\n".join(lines)
    if name == "list_content":
        items = notes_api.list_content(chat["subject_id"])
        return "Looking through your notes", ("\n".join(f"- {i['title']} ({i['kind']})" for i in items)
                                              or "(No notes or generated notes yet.)")
    item = notes_api.find_content(chat["subject_id"], str(args.get("title", "")))
    if item is None:
        return "Looking for that note", f"(No note or generated content called “{args.get('title', '')}”. Use list_content.)"
    _, secs = review.target_sections({"target": item["target"], "target_id": item["id"]})
    text = "\n\n".join((f"## {sec['title']}\n" if len(secs) > 1 else "") + review.plain_text(sec["html"]) for sec in secs)
    cut = len(text) > 24000
    return f"Reading “{item['title'][:60]}”", (f"=== {item['title']} ({item['kind']}) ===\n{text[:24000]}"
                                              + ("\n(… the rest was cut off)" if cut else "") + f"\n=== End of {item['title']} ===")


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
        a = db.q1("SELECT id, type, title, status, progress, message, error FROM artifacts WHERE id=?", (aid,))
        m["artifact"] = a
    return m


def _add_message(cid, role, content="", meta=None):
    mid = db.ex("INSERT INTO messages(chat_id, role, content, meta, created_at) VALUES (?,?,?,?,?)",
                (cid, role, content, json.dumps(meta or {}), time.time()))
    db.ex("UPDATE chats SET updated_at=? WHERE id=?", (time.time(), cid))
    return _msg_out(db.q1("SELECT * FROM messages WHERE id=?", (mid,)))


# ---------------------------------------------------------------- chats

class NewChat(BaseModel):
    topic_id: int | None = None


@router.get("/subjects/{sid}/chats")
def list_chats(sid: int):
    return db.q("SELECT * FROM chats WHERE subject_id=? ORDER BY updated_at DESC", (sid,))


@router.post("/subjects/{sid}/chats")
def create_chat(sid: int, body: NewChat):
    if not db.q1("SELECT id FROM subjects WHERE id=?", (sid,)):
        raise HTTPException(404, "Subject not found")
    now = time.time()
    cid = db.ex("INSERT INTO chats(subject_id, topic_id, created_at, updated_at) VALUES (?,?,?,?)", (sid, body.topic_id, now, now))
    return db.q1("SELECT * FROM chats WHERE id=?", (cid,))


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
    db.ex("DELETE FROM chats WHERE id=?", (cid,))
    return {"ok": True}


@router.get("/chats/{cid}")
def get_chat(cid: int):
    c = _chat(cid)
    c["messages"] = [_msg_out(m) for m in db.q("SELECT * FROM messages WHERE chat_id=? ORDER BY id", (cid,))]
    return c


# ---------------------------------------------------------------- messages (streamed)

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


# ---------------------------------------------------------------- files sent straight to the chat


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
            tb = "" if context.uses_reference_material(chat["subject_id"], chat["topic_id"]) else                 context.textbook_passages(chat["subject_id"], query, k=4)
            if tb:
                extra += "\n\n[Relevant textbook passages, authoritative reference]\n" + tb
            if extra:
                last = hist[-1]["content"]
                hist[-1] = {"role": "user", "content": last + extra if isinstance(last, str)
                            else [{"type": "text", "text": last[0]["text"] + extra}, *last[1:]]}
            yield ev({"type": "status", "text": "Reading your material"})
            convo = [{"role": "system", "content": system}, *hist]
            level = reasoning if reasoning in ("low", "medium", "xhigh") else "off"
            reasoning_text = ""
            r_start = r_end = None  # time spent reasoning, shown on the collapsed reasoning block
            searched: list[str] = []

            def meta():
                secs = round((r_end or time.time()) - r_start, 1) if r_start else None
                out = {"reasoning": reasoning_text, "reasoning_seconds": secs, "reasoning_level": level}
                if searched:
                    out["searched_other_topics"] = searched
                return out

            prefix = ""  # what Qwen said before searching stays part of the same reply
            content = ""
            for round_ in range(3):  # each search of other topics feeds back in; at most two per turn
                content, searches = "", []
                for kind, data in llm.chat_stream(convo, tools=tools, max_tokens=6000 if level == "off" else 16000, reasoning=level):
                    if tracked.cancelled():  # Cancel in the jobs list
                        raise pipeline.Cancelled()
                    if kind == "reasoning" and not reasoning_text:
                        tracked.update("Thinking")
                    elif kind == "content" and not content:
                        tracked.update("Writing the reply")
                    if kind == "content":
                        if r_start and not r_end:
                            r_end = time.time()
                        content += data
                        yield ev({"type": "delta", "text": data})
                    elif kind == "reasoning":
                        r_start = r_start or time.time()
                        reasoning_text += data
                        yield ev({"type": "reasoning", "text": data})
                    elif kind == "tool_calls":
                        if r_start and not r_end:
                            r_end = time.time()
                        searches = [c for c in data if c["name"] in READ_TOOLS]
                        if len(searches) < len(data) and (prefix + content).strip():
                            yield ev({"type": "assistant", "message": _add_message(cid, "assistant", (prefix + content).strip(), meta())})
                            prefix = content = ""
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
                        searched.append(str((s["arguments"] or {}).get("query") or user_msg["content"]))
                    status, result = _read_tool(chat, s, others, user_msg["content"])
                    yield ev({"type": "status", "text": status})
                    tracked.update(status)
                    call_id = s.get("id") or f"call_{round_}_{k}"
                    calls.append({"id": call_id, "type": "function",
                                  "function": {"name": s["name"], "arguments": json.dumps(s["arguments"] or {})}})
                    results.append({"role": "tool", "tool_call_id": call_id, "content": result})
                convo += [{"role": "assistant", "content": content, "tool_calls": calls}, *results]
                if content.strip():
                    prefix += content.strip() + "\n\n"
                    yield ev({"type": "delta", "text": "\n\n"})
            final = (prefix + content).strip()
            if final:
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
        except pipeline.Cancelled:
            tracked.stop()
            yield ev({"type": "error", "text": "Stopped from the jobs list."})
        except Exception as e:
            tracked.fail(str(e))
            yield ev({"type": "error", "text": str(e)})

    return StreamingResponse(events(), media_type="text/event-stream")


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


# ---------------------------------------------------------------- tool forms -> artifacts

def _todo_message(chat, args):
    """add_todos: added straight away (no form); the chat shows what was added."""
    args = args if isinstance(args, dict) else {}
    topic_id = chat["topic_id"]
    if args.get("topic"):
        t = db.q1("SELECT id FROM topics WHERE subject_id=? AND name=? COLLATE NOCASE", (chat["subject_id"], str(args["topic"]).strip()))
        topic_id = t["id"] if t else topic_id
    added = []
    for it in args.get("items") or []:
        text, note = (it, "") if isinstance(it, str) else (str(it.get("text", "")), str(it.get("note", "") or ""))
        if text.strip():
            study_api.add_todo(chat["subject_id"], study_api.TodoBody(text=text.strip()[:200], note=note, topic_id=topic_id, source="chat"))
            added.append(text.strip()[:200])
    meta = {"tool": "add_todos", "status": "done", "todos": added}
    return _add_message(chat["id"], "tool", f"Added {len(added)} to-do{'s' if len(added) != 1 else ''}", meta)


def _review_message(chat, args):
    """review_content: Apollo checks or revises a note in the background; the chat shows a card that follows it."""
    args = args if isinstance(args, dict) else {}
    item = notes_api.find_content(chat["subject_id"], str(args.get("title", "")))
    mode = "revise" if args.get("mode") == "revise" else "check"
    if item is None:
        meta = {"tool": "review_content", "status": "failed", "error": f"No note called “{args.get('title', '')}” was found."}
        return _add_message(chat["id"], "tool", "Couldn't find that note", meta)
    try:
        r = notes_api.create_review(chat["subject_id"], notes_api.NewReview(
            target=item["target"], target_id=item["id"], mode=mode, instruction=str(args.get("instruction") or "")), chat["id"])
    except HTTPException as e:
        meta = {"tool": "review_content", "status": "failed", "error": str(e.detail)}
        return _add_message(chat["id"], "tool", "Couldn't start that", meta)
    meta = {"tool": "review_content", "status": "submitted", "review_id": r["id"], "mode": mode, "title": item["title"],
            "target": item["target"], "target_id": item["id"], "instruction": r["instruction"]}
    return _add_message(chat["id"], "tool", f"{'Checking' if mode == 'check' else 'Revising'} {item['title']}", meta)


def _tool_message(chat, tool, args):
    kind = generate.TOOLS[tool]
    meta = {"tool": tool, "type": kind, "args": args or {}, "status": "form", "topic_id": chat["topic_id"]}
    return _add_message(chat["id"], "tool", f"Create {generate.TYPE_TITLES[kind].lower()}", meta)


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
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (aid,))
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
    return db.q("SELECT id, topic_id, type, title, status, created_at FROM artifacts WHERE subject_id=? ORDER BY id DESC", (sid,))


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
