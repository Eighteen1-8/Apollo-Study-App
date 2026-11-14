"""What the chat model can call: the tool specs, the read-only tools answered within the same turn, and the
messages a tool call becomes (a to-do note, a review card, a content form)."""
import logging
import re

from fastapi import HTTPException

from . import about, citations, context, db, generate, notes_api, review, search, study_api

log = logging.getLogger(__name__)
from .chats import _add_message


# Every create tool can be narrowed to one file, or some of its pages/slides ("slides 10-20 of Lecture 3")
PAGES = {
    "file": {"type": "string", "description": "optional: only this file, named as in your citations"},
    "pages": {"type": "string", "description": "optional, with file: which pages/slides/sections, e.g. '10-20' or '3, 5-7'"},
}

TOOL_SPECS = [
    {"type": "function", "function": {"name": "create_flashcards", "description":
        "Create a set of flashcards from the student's material for the selected topic scope.",
        "parameters": {"type": "object", "properties": {
            "count": {"type": "integer", "description": "number of cards, default 20"},
            "focus": {"type": "string", "description": "optional sub-area to focus on"}, **PAGES}}}},
    {"type": "function", "function": {"name": "create_quiz", "description":
        "Create a short quiz (multiple choice, optionally true/false) with explanations from the student's material.",
        "parameters": {"type": "object", "properties": {
            "count": {"type": "integer", "description": "number of questions, default 10"},
            "difficulty": {"type": "string", "enum": ["easy", "normal", "hard"]},
            "focus": {"type": "string"}, **PAGES}}}},
    {"type": "function", "function": {"name": "create_exam", "description":
        "Create a full exam modelled on a practice exam the student uploads (same structure, new questions), marked by the tutor.",
        "parameters": {"type": "object", "properties": {
            "difficulty": {"type": "string", "enum": ["easy", "normal", "hard"]}, **PAGES}}}},
    {"type": "function", "function": {"name": "create_notes", "description":
        "Compile comprehensive structured study notes from all the material in scope.",
        "parameters": {"type": "object", "properties": {"focus": {"type": "string"}, **PAGES}}}},
    {"type": "function", "function": {"name": "create_cheatsheet", "description":
        "Create a one-page cheat sheet of key definitions and formulas.",
        "parameters": {"type": "object", "properties": {"focus": {"type": "string"}, **PAGES}}}},
    {"type": "function", "function": {"name": "create_mindmap", "description":
        "Create a mind map showing how the ideas in the student's material connect.",
        "parameters": {"type": "object", "properties": {"focus": {"type": "string"}, **PAGES}}}},
    {"type": "function", "function": {"name": "view_todos", "description":
        "Read the student's revision to-do list (what's done and what's still to do). Use it when the student asks "
        "about their to-dos, what to revise next, or their progress, or before planning their revision.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "list_content", "description":
        "List the student's own notes, mind maps and drawings, the generated notes and cheat sheets, and Apollo's markings "
        "of the student's work in this subject, by title.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "read_content", "description":
        "Read one of the student's notes, a generated notes / cheat sheet, or a marking (see list_content) to answer questions "
        "about it. A mind map reads as an outline of its boxes and links; a drawing only as its title and the student's "
        "description; a marking as its score, summary and each question's marks and feedback.",
        "parameters": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}}},
    {"type": "function", "function": {"name": "review_content", "description":
        "Check whether one of the student's notes or a generated notes / cheat sheet is correct (mode 'check'), or "
        "change it as the student asks (mode 'revise': add, fix, shorten, reorganise...). Runs in the background; the "
        "student sees the result on the note and decides whether to apply a revision. Mind maps and drawings can only be "
        "checked, and a drawing only after the student has pressed Check with Apollo on it once.",
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
    {"type": "function", "function": {"name": "search_material", "description":
        "Search the student's study material for passages you haven't been given yet. Use it when the material and "
        "excerpts you have don't answer the question, with a more specific query than the student's wording, before "
        "falling back to general knowledge. Each call returns new passages.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "what to look for: specific terms, names, formulas"},
            "where": {"type": "string", "enum": ["this_topic", "whole_subject", "textbooks"],
                      "description": "this_topic: the material this chat uses (default); whole_subject: every topic and "
                                     "textbook in the subject; textbooks: the reference library only"}},
            "required": ["query"]}}},
    {"type": "function", "function": {"name": "app_info", "description":
        "Read how the Apollo study app works: what Apollo is and why it exists, each feature and how to use it, slash "
        "commands, keyboard shortcuts, settings, privacy. Call it for any question about yourself or the app instead of "
        "guessing.",
        "parameters": {"type": "object", "properties": {
            "topic": {"type": "string", "description": "one of: " + ", ".join(about.SECTIONS) + "; or words to "
                      "look for; empty for everything"}}}}},
]


READ_TOOLS = ("search_other_topics", "view_todos", "list_content", "read_content", "search_material", "app_info")
SEARCH_K = 8


def _material_ids(chat, where: str) -> list[int]:
    """The documents search_material looks in."""
    if where == "textbooks":
        return [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind='reference' AND unit_count > 0",
                                      (chat["subject_id"],))]
    if where == "whole_subject":
        return [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind IN ('topic', 'reference') "
                                      "AND unit_count > 0", (chat["subject_id"],))]
    return [d["id"] for d in context.topic_documents(chat["subject_id"], chat["topic_id"])]


def _fresh_hits(q: str, ids: list[int], seen: set | None) -> list[dict]:
    """Top passages leaving out chunks already given this turn (auto-retrieved or an earlier tool result), so each
    search brings new text; what's returned joins `seen`."""
    seen = seen if seen is not None else set()
    hits = [h for h in search.search(q, ids, k=SEARCH_K + len(seen)) if h["chunk_id"] not in seen][:SEARCH_K]
    seen.update(h["chunk_id"] for h in hits)
    return hits


WHERE_WORDS = {"this_topic": "this topic", "whole_subject": "the whole subject", "textbooks": "your textbooks"}


def _read_tool(chat, call, others: list[int], fallback_query: str, seen: set | None = None) -> tuple[str, str]:
    """(status shown to the student, result for the model) for a tool that only reads. `seen`: chunk ids already
    given to the model this turn (updated with what a search returns)."""
    args = call["arguments"] if isinstance(call["arguments"], dict) else {}
    name = call["name"]
    if name == "search_other_topics":
        q = str(args.get("query") or fallback_query)
        try:
            hits = context._format_hits(_fresh_hits(q, others, seen))
        except Exception as e:  # e.g. embeddings offline
            hits = f"(search failed: {e})"
        return f"Searching your other topics for “{q[:60]}”", f"[Material from the student's other topics]\n{hits or '(nothing relevant found)'}"
    if name == "search_material":
        q = str(args.get("query") or fallback_query)
        where = args.get("where") if args.get("where") in WHERE_WORDS else "this_topic"
        try:
            hits = context._format_hits(_fresh_hits(q, _material_ids(chat, where), seen))
        except Exception as e:  # e.g. embeddings offline
            hits = f"(search failed: {e})"
        return (f"Looking deeper in your material for “{q[:60]}”",
                f"[Passages from {WHERE_WORDS[where]} for “{q}”, not given before]\n"
                + (hits or "(nothing new found: answer from what you have, or say the material doesn't cover it)"))
    if name == "app_info":
        topic = str(args.get("topic") or "")
        return "Checking what I can do", f"[About the Apollo app{f': {topic}' if topic else ''}]\n{about.info(topic)}"
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
    text = "\n\n".join((f"## {sec['title']}\n" if len(secs) > 1 else "") + review.section_text(sec, outline=True) for sec in secs)
    cut = len(text) > 24000
    return f"Reading “{item['title'][:60]}”", (f"=== {item['title']} ({item['kind']}) ===\n{text[:24000]}"
                                              + ("\n(… the rest was cut off)" if cut else "") + f"\n=== End of {item['title']} ===")


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


_RANGE = re.compile(r"(\d+)\s*(?:-|–|—|to|until|through)\s*(?:(?:slides?|pages?|sections?)\s*)?(\d+)|(\d+)", re.I)


def page_numbers(text: str) -> list[int]:
    """'slides 10–20', '3, 5-7', 'page 4' → the numbers, in order (at most 2000)."""
    out: list[int] = []
    for m in _RANGE.finditer(str(text or "")):
        if m.group(3):
            out.append(int(m.group(3)))
        else:
            a, b = sorted((int(m.group(1)), int(m.group(2))))
            out += range(a, min(b, a + 2000) + 1)
    return sorted(set(out))[:2000]


def pages_choice(chat, args: dict) -> tuple[dict | None, str]:
    """The file (and pages) a create tool call names: ({"doc id": [unit idx, ...]}, filename) resolved with the citation
    helpers and checked like Make content's choice (chat_api._checked_units), or (None, why not) for the form to say."""
    file = str(args.get("file") or "").strip()
    if not file:
        return None, ""
    doc = citations.doc_for(chat["subject_id"], file)
    if doc is None:
        return None, f"Apollo couldn't find a file called “{file}”, so all the material is used. Choose pages below if you like."
    valid = [r["idx"] for r in db.q("SELECT idx FROM units WHERE document_id=? ORDER BY idx", (doc["id"],))]
    pages = page_numbers(args.get("pages") or "") if str(args.get("pages") or "").strip() else valid
    picked = [i for i in pages if i in set(valid)]
    if not picked:
        return None, f"{doc['filename']} has no {args.get('pages')}, so all the material is used."
    from .chat_api import _checked_units  # here: chat_api imports this module
    try:
        units = _checked_units(chat["subject_id"], {doc["id"]: picked})
    except HTTPException as e:
        return None, str(e.detail)
    return {str(k): v for k, v in (units or {}).items()}, doc["filename"]


def _tool_message(chat, tool, args):
    kind = generate.TOOLS[tool]
    args = dict(args or {}) if isinstance(args, dict) else {}
    meta = {"tool": tool, "type": kind, "args": args, "status": "form", "topic_id": chat["topic_id"]}
    if args.get("file") or args.get("units"):
        units, said = pages_choice(chat, args) if args.get("file") else (args["units"], "")
        if units:
            args["units"] = units
            meta["file"] = said or None
        else:
            args.pop("units", None)
            meta["notice"] = said
    return _add_message(chat["id"], "tool", f"Create {generate.TYPE_TITLES[kind].lower()}", meta)
