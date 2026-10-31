"""Chat with Qwen about a subject (optionally scoped to one topic). Content creation happens through tool calls:
the model (or a quick-action button) creates a 'tool' message holding a form; submitting it starts a generation job."""
import json
import tempfile
import time
from pathlib import Path

from PIL import Image

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import config, context, db, figures, generate, jobs, llm, search, study_api
from .parsers import IMAGE_EXTS, SUPPORTED, approx_tokens, parse, sha

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


DEFAULT_RULES = """You are Apollo, a patient, precise study tutor. The student is studying {scope}.
How to answer:
- Ground every answer in the student's STUDY MATERIAL (and textbook passages when given). Prefer quoting it: use short
  verbatim quotes in quotation marks for definitions, laws and key statements, then explain them in your own words.
- Cite every fact you take from the material as [[filename · label]], using the exact document filename and the exact
  unit label from the material headers, e.g. [[Wave Behaviours and Light Phenomena.pptx · Slide 32]] or
  [[ElectricalCircuits.pdf · Page 20]]. The app turns these into links that open the source.
- Only use your own general knowledge when the material does not cover something. Then say so plainly
  ("Your material doesn't cover this; from general physics knowledge: ...") and never cite it.
- Items marked [Visual content] describe diagrams from the slides/pages; use them and cite their slide/page.
- Use Markdown, and LaTeX between $...$ for maths."""

# Not editable in settings: the app depends on these.
TOOL_RULES = """Your name is Apollo (the study app's tutor); if asked who you are, you are Apollo.
When the student asks you to make flashcards, a quiz, an exam, notes or a cheat sheet, call the matching
tool instead of writing the content yourself; the app will show them a form to confirm. When they ask you to plan their
revision or to add something to their to-do list, call add_todos.
Visuals, when they help the student understand (not in every reply):
- Show a figure from their material by writing, on its own line: [[figure: filename · unit label | what it shows]]
  Only for figures a [Visual content] description shows exist, with that unit's exact label. The app crops it from the
  page. At most 3 per reply.
- Graph a relationship with a fenced block (valid JSON; expr may use x, + - * / ^, sin cos tan sqrt exp ln log abs, pi, e):
  ```plot
  {"title": "...", "x": [0, 10], "xlabel": "...", "ylabel": "...", "functions": [{"expr": "2*x^2", "label": "..."}], "points": [{"x": 1, "y": 2, "label": "..."}]}
  ```
  The student can hover it to read values. When exploring how a quantity changes the curve helps, add sliders:
  "params": [{"name": "R1", "label": "R1 (kΩ)", "min": 1, "max": 10, "step": 0.5, "value": 2}] and use the names in expr.
- Draw a simple labelled diagram as inline <svg viewBox="0 0 400 220" class="diagram"> with lines, rects, circles,
  polygons and <text font-size="13">, using stroke="currentColor" and fill="none".
- Colour or <mark> a key phrase sparingly."""

# Personality tuner (settings): each dial 0-2.
STYLE = {
    "chat_assistive": ["",
                       "When the student is working on a problem, show the method step by step.",
                       "Teach the method every time: work through problems step by step, saying what you do at each "
                       "step and why, and add a short worked example when it helps."],
    "chat_concise": ["Be thorough: explain fully, with context and examples.",
                     "",
                     "Be concise: answer directly in as few words as needed, no preamble or recap; expand only if asked."],
    "chat_interactive": ["",
                         "Where it helps learning, end with one quick question that checks the student's understanding.",
                         "Be Socratic: don't give the final answer straight away. Break the problem into smaller "
                         "questions and ask them one at a time, giving hints; give the full answer only when the "
                         "student asks for it or is stuck."],
}


def _rules(scope: str) -> str:
    custom = (db.setting("chat_system_prompt") or "").strip()
    rules = (custom or DEFAULT_RULES).replace("{scope}", scope)
    style = []
    for key, levels in STYLE.items():
        try:
            line = levels[max(0, min(2, int(db.setting(key))))]
        except (TypeError, ValueError):
            line = ""
        if line:
            style.append(f"- {line}")
    return rules + ("\nStyle:\n" + "\n".join(style) if style else "") + "\n" + TOOL_RULES


@router.get("/chat/default-prompt")
def default_prompt():
    return {"prompt": DEFAULT_RULES}


def _system_prompt(chat) -> tuple[str, bool]:
    """Returns (system prompt, full_context). Full context when the scope fits. Rules + material are identical every turn
    (prefix cache); only the short student-progress tail after the material can change."""
    rules = _rules(context.scope_label(chat["subject_id"], chat["topic_id"]))
    if _other_topic_docs(chat):
        rules += "\n" + OTHER_TOPICS_RULE
    struggles = study_api.struggling_cards(chat["subject_id"], chat["topic_id"])
    tail = ""
    if struggles:
        tail = ("\n\n=== STUDENT PROGRESS ===\nThe student marked these flashcards as 'I need more revision on this'. "
                "They are struggling with these ideas: explain them extra carefully, check understanding, and connect "
                "answers to them where relevant:\n" + "\n".join(f"- {c['front']}" for c in struggles))
    budget = int(llm.context_tokens() * 0.55)
    groups = context.material_groups(chat["subject_id"], chat["topic_id"], budget)
    if not groups:
        return rules + "\n\n(No material has been uploaded for this scope yet.)" + tail, True
    if len(groups) == 1:
        return f"{rules}\n\n=== STUDY MATERIAL ===\n{groups[0]['text']}{tail}", True
    return rules + "\n\nThe material is too large to show at once; relevant excerpts are attached to each question." + tail, False


def _user_text(content: str, meta: dict) -> str:
    """A student turn as the model sees it: the highlighted passage and attached file names come first."""
    parts = []
    q = meta.get("quote")
    if q:
        src = f"{q['filename']} · {q['label']}" if q.get("label") else q["filename"]
        parts.append(f"[The student highlighted a passage in [[{src}]] and is asking about it]\n"
                     f"Passage: \"…{q['before']} **{q['text']}** {q['after']}…\"\n"
                     f"Highlighted part: \"{q['text']}\"")
    if meta.get("attachments"):
        parts.append("[Files the student attached to this message: " + ", ".join(a["filename"] for a in meta["attachments"]) + "]")
    for f in meta.get("files", []):
        if f["kind"] == "text":
            parts.append(f"=== File sent with this message (not in the course library): {f['name']} ===\n{f['text']}\n"
                         f"=== End of {f['name']} ===")
        else:
            parts.append(f"[Image sent with this message: {f['name']}]")
    parts.append(content)
    return "\n\n".join(parts)


IMAGE_TOKENS = 1500  # rough cost of one image in the prompt


def _user_content(content: str, meta: dict):
    """Plain text, or text + image parts when images were sent with the message."""
    text = _user_text(content, meta)
    images = [f for f in meta.get("files", []) if f["kind"] == "image"]
    if not images:
        return text
    parts = [{"type": "text", "text": text}]
    for f in images:
        p = config.assets_dir() / f["asset"]
        if p.is_file():
            parts.append(llm.image_part(p.read_bytes(), "image/png"))
    return parts


def _tokens(content) -> int:
    if isinstance(content, str):
        return approx_tokens(content)
    return sum(approx_tokens(p["text"]) if p["type"] == "text" else IMAGE_TOKENS for p in content)


def _history(cid, limit_tokens=12000):
    """Recent turns within the budget; the latest turn is always included, however long."""
    out, used = [], 0
    for m in reversed(db.q("SELECT * FROM messages WHERE chat_id=? ORDER BY id", (cid,))):
        meta = json.loads(m["meta"] or "{}")
        if m["role"] == "tool":
            if meta.get("tool") == "add_todos":
                text = "(Added to the student's to-do list: " + "; ".join(meta.get("todos", [])) + ")"
            else:
                text = f"(Opened the {meta.get('tool', 'tool')} form for the student.)"
            role = "assistant"
        elif m["role"] == "user":
            text, role = _user_content(m["content"], meta), "user"
        else:
            text, role = m["content"], m["role"]
        if not text:
            continue
        used += _tokens(text)
        if used > limit_tokens and out:
            break
        out.append({"role": role, "content": text})
    return list(reversed(out))


# ---------------------------------------------------------------- files sent straight to the chat

def _read_chat_file(path_str: str) -> dict:
    """Read a file for one chat message without ingesting it. Text files must fit the word limit; images are kept
    as PNG under assets/chat/ so later turns can still show them to Qwen."""
    path = Path(path_str)
    ext = path.suffix.lower()
    if not path.is_file():
        raise HTTPException(400, f"{path.name}: file not found")
    if ext in IMAGE_EXTS:
        blob = path.read_bytes()
        rel = f"chat/{sha(blob)[:24]}.png"
        out = config.assets_dir() / rel
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            try:
                im = Image.open(path)
                im.thumbnail((2048, 2048))
                im.convert("RGB").save(out, "PNG")
            except Exception:
                raise HTTPException(400, f"{path.name}: couldn't read this image")
        out = {"name": path.name, "kind": "image", "asset": rel}
        snap = db.q1("SELECT document_id, unit, rect FROM snapshots WHERE path=?", (str(path.resolve()),))
        if snap:  # a screenshot from the viewer: remember where it came from
            out["source"] = {"document_id": snap["document_id"], "unit": snap["unit"], "rect": json.loads(snap["rect"])}
        return out
    if ext not in SUPPORTED:
        raise HTTPException(400, f"{path.name}: unsupported file type {ext}")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            units, _ = parse(path, Path(tmp), {**config.DEFAULT_SETTINGS, **db.get_settings()})
        except Exception as e:
            raise HTTPException(400, f"{path.name}: couldn't read this file ({e})")
    text = "\n\n".join(f"[{u['label']}]\n{u['text'].strip()}" for u in units if u["text"].strip())
    words = len(text.split())
    limit = int(db.setting("chat_file_word_limit"))
    if not words:
        raise HTTPException(400, f"{path.name} has no readable text (it may be scanned). Add it to a topic or the "
                                 "reference library so it's ingested (vision can read it), then ask about it.")
    if words > limit:
        raise HTTPException(413, f"{path.name} is too long to send straight to the chat ({words:,} words; the limit is "
                                 f"{limit:,}). Add it to a topic or the reference library so it's ingested, then ask about it.")
    return {"name": path.name, "kind": "text", "text": text, "words": words}


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


ATTACHED_RULES = """[The student attached the file(s) above to this question]
Answer explicitly from the attached file(s) first. Cite library files as [[filename · label]]; refer to files sent with
the message (not in the course library) by name and page/slide in plain text, without [[...]]. Use other material only
to fill gaps, cited as usual. If the question has nothing to do with the attached file(s), still answer as well as you can, and
start your reply by briefly telling the student that the attached file doesn't seem related to their question."""

QUOTE_RULES = """[About the highlighted passage]
Answer about the highlighted part specifically, in the context of its passage, and cite its source. Bring in other
material (cited) when it helps the student understand it."""


def _attachment_material(chat, docs: list[dict], query: str, full: bool) -> str:
    """Attached files' text for the latest turn. Files already in the system prompt aren't repeated; long files
    contribute their most relevant parts."""
    in_prompt = {d["id"] for d in context.topic_documents(chat["subject_id"], chat["topic_id"])} if full else set()
    budget = int(llm.context_tokens() * 0.2 / max(len(docs), 1))
    blocks = []
    for d in docs:
        if d["id"] in in_prompt:
            blocks.append(f"=== Attached: {d['filename']} (its full text is in the STUDY MATERIAL above) ===")
            continue
        secs = context.document_sections({**d, "topic_name": d["topic_name"] or "reference library"}, budget)
        if len(secs) == 1:
            blocks.append(secs[0]["text"].replace("=== Document:", "=== Attached:", 1))
        elif secs:
            hits = context._format_hits(search.search(query, [d["id"]], k=10))
            blocks.append(f"=== Attached: {d['filename']} (too long to show in full; its most relevant parts) ===\n{hits}")
        else:
            blocks.append(f"=== Attached: {d['filename']} (no text extracted yet) ===")
    return "\n\n".join(blocks)


SEARCH_TOOL = {"type": "function", "function": {"name": "search_other_topics", "description":
    "Search the student's material in the OTHER topics of this subject, which you normally can't see. Only use it when "
    "the student explicitly asks you to look in other topics or everywhere, or insists that you find something the "
    "material you have doesn't contain.",
    "parameters": {"type": "object", "properties": {
        "query": {"type": "string", "description": "what to look for, in the student's terms"}}, "required": ["query"]}}}

OTHER_TOPICS_RULE = """The student's other topics in this subject are NOT included above. If the student explicitly asks
you to look in other topics (or everywhere), or insists you find something this material doesn't contain, call
search_other_topics, then answer from what it returns and cite it as usual."""


def _other_topic_docs(chat) -> list[int]:
    if chat["topic_id"] is None:
        return []
    return [r["id"] for r in db.q("""SELECT id FROM documents WHERE subject_id=? AND kind='topic' AND topic_id<>?
                                     AND unit_count > 0""", (chat["subject_id"], chat["topic_id"]))]


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
            tb = context.textbook_passages(chat["subject_id"], query, k=4)
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
                        searches = [c for c in data if c["name"] == "search_other_topics"]
                        if len(searches) < len(data) and (prefix + content).strip():
                            yield ev({"type": "assistant", "message": _add_message(cid, "assistant", (prefix + content).strip(), meta())})
                            prefix = content = ""
                        for call in data:
                            if call["name"] in generate.TOOLS:
                                yield ev({"type": "tool", "message": _tool_message(chat, call["name"], call["arguments"])})
                            elif call["name"] == "add_todos":
                                yield ev({"type": "tool", "message": _todo_message(chat, call["arguments"])})
                if not searches or round_ == 2:
                    break
                calls, results = [], []
                for k, s in enumerate(searches):
                    q = str((s["arguments"] or {}).get("query") or user_msg["content"])
                    searched.append(q)
                    yield ev({"type": "status", "text": f"Searching your other topics for “{q[:60]}”"})
                    try:
                        hits = context._format_hits(search.search(q, others, k=8))
                    except Exception as e:  # e.g. embeddings offline
                        hits = f"(search failed: {e})"
                    call_id = s.get("id") or f"call_{round_}_{k}"
                    calls.append({"id": call_id, "type": "function",
                                  "function": {"name": s["name"], "arguments": json.dumps(s["arguments"] or {})}})
                    results.append({"role": "tool", "tool_call_id": call_id,
                                    "content": f"[Material from the student's other topics]\n{hits or '(nothing relevant found)'}"})
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
                    found.update(figures.resolve(chat["subject_id"], tag, limit=1))
                m = meta()
                if found:
                    m["figures"] = found
                yield ev({"type": "assistant", "message": _add_message(cid, "assistant", final, m)})
        except Exception as e:
            yield ev({"type": "error", "text": str(e)})
        yield ev({"type": "end"})

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
        if not args.get("practice_exam_path") or not Path(args["practice_exam_path"]).is_file():
            raise HTTPException(400, "Upload a practice exam")
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
