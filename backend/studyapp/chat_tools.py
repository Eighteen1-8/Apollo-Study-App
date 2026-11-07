"""What the chat model can call: the tool specs, the read-only tools answered within the same turn, and the
messages a tool call becomes (a to-do note, a review card, a content form)."""
import logging

from fastapi import HTTPException

from . import context, db, generate, notes_api, review, search, study_api

log = logging.getLogger(__name__)
from .chats import _add_message


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
