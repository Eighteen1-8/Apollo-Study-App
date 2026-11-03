"""What the chat sends Qwen: the tutor's rules and style, the scope's material in the system prompt (byte-identical across
turns so the prefix cache hits), the conversation history within a token budget, attached files and documents, and the
rule and tool for searching the subject's other topics."""
import json

from . import config, context, db, llm, search, study_api
from .parsers import approx_tokens


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
When the student asks you to make flashcards, a quiz, an exam, notes, a cheat sheet or a mind map, call the matching
tool instead of writing the content yourself; the app will show them a form to confirm. When they ask you to plan their
revision or to add something to their to-do list, call add_todos; to see their to-do list, call view_todos (you can't
see it otherwise). The student's own notes and the generated notes and cheat sheets aren't in your context: use
list_content and read_content to read one, and review_content when they ask you to check one or to change one.
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
            elif meta.get("tool") == "review_content":
                text = (f"(Started {'checking' if meta.get('mode') == 'check' else 'revising'} “{meta.get('title', '')}” in "
                        "the background; the student sees the result on it.)" if meta.get("review_id")
                        else f"(review_content failed: {meta.get('error', '')})")
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
