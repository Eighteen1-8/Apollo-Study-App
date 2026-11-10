"""Content generators (flashcards, quiz, notes, cheat sheet, mind map, exam) and exam marking.

Every generator works group by group (see context.material_groups). Within a group the system message
(rules + material) is identical for every call, so only the first call pays the prefill cost."""
import json
import re
import tempfile
import time
from pathlib import Path

from pydantic import BaseModel, Field

from . import citations, context, db, errors, figures, llm, notehtml, pipeline
from .parsers import IMAGE_EXTS, approx_tokens, parse, render_pdf_page, sha

TOOLS = {
    "create_flashcards": "flashcards",
    "create_quiz": "quiz",
    "create_exam": "exam",
    "create_notes": "notes",
    "create_cheatsheet": "cheatsheet",
    "create_mindmap": "mindmap",
}
TYPE_TITLES = {"flashcards": "Flashcards", "quiz": "Quiz", "exam": "Exam", "notes": "Notes", "cheatsheet": "Cheat sheet",
               "mindmap": "Mind map"}

DIFFICULTY = {
    "easy": "EASY: keep the same structure and marks, but make every question simpler than the practice exam: "
            "more recall and direct application, fewer steps in calculations, more obvious MCQ distractors, more scaffolding.",
    "normal": "NORMAL: match the practice exam's difficulty closely: same cognitive level per part, same calculation depth, "
              "similar distractor quality and answer length.",
    "hard": "HARD: keep the same structure and marks, but make every question harder than the practice exam: more analysis "
            "and evaluation, multi-step calculations, closer MCQ distractors, questions combining several concepts.",
}


def _gen_budget():
    return int(llm.context_tokens() * 0.6)


def _system(subject_scope: str, group: dict) -> str:
    return (f"You are Apollo, an expert teacher creating study material for a student studying {subject_scope}.\n"
            "The STUDY MATERIAL below is the source of truth. Base everything on it; do not invent facts that contradict it. "
            "Items marked [Visual content] describe diagrams and figures from the slides/pages; use them too. "
            "Write equations in LaTeX between $...$. Every item must cite its source as 'filename · Slide/Page/Section label'.\n\n"
            f"=== STUDY MATERIAL ===\n{group['text']}")


def _allocate(total: int, weights: list[float]) -> list[int]:
    """Split `total` items proportionally to weights (largest remainder). Deterministic."""
    if not weights or total <= 0:
        return [0] * len(weights)
    s = sum(weights) or 1
    raw = [total * w / s for w in weights]
    out = [int(r) for r in raw]
    for i in sorted(range(len(raw)), key=lambda i: raw[i] - out[i], reverse=True)[: total - sum(out)]:
        out[i] += 1
    return out


def _focus_text(params):
    f = (params.get("focus") or "").strip()
    return (f"\nFocus on: {f}. Still stay within the material." if f else "") + _extra_text(params)


def _extra_text(params):
    """Files the student added for this one request (read when it was made, never ingested) and what to do with them.
    Goes after the cached material, in the task."""
    out = ""
    extra = params.get("extra") or []
    if extra:
        out += ("\n\nEXTRA MATERIAL the student added for this request only (it is not part of their study files). "
                "Use it the way their instructions say; if they give none, use it to decide what matters most:\n"
                + "\n\n".join(f"=== {e['name']} ===\n{e['text']}" for e in extra))
    ins = (params.get("instructions") or "").strip()
    if ins:
        out += f"\n\nThe student's instructions for this request: {ins}\nFollow them, still basing the content on the study material."
    return out


def _textbook(subject_id, query, topic_id=None):
    if context.uses_reference_material(subject_id, topic_id):
        return ""  # the textbooks are the material already
    tb = context.textbook_passages(subject_id, query, k=4)
    return f"\n\nRelevant textbook passages (authoritative reference, use to check facts and add depth):\n{tb}" if tb else ""


class Progress:
    def __init__(self, artifact_id, job):
        self.id, self.job = artifact_id, job

    def __call__(self, frac, msg):
        self.job.check()
        self.job.update(frac, msg)
        db.ex("UPDATE artifacts SET progress=?, message=?, updated_at=? WHERE id=?", (frac, msg, time.time(), self.id))

    def message(self, msg):
        """Change the status line without moving the progress bar."""
        self.job.check()
        db.ex("UPDATE artifacts SET message=?, updated_at=? WHERE id=?", (msg, time.time(), self.id))


# ---------------------------------------------------------------- flashcards & quiz

class Card(BaseModel):
    front: str
    back: str
    source: str = ""


class Cards(BaseModel):
    cards: list[Card]


class MCQ(BaseModel):
    question: str
    options: list[str] = Field(min_length=4, max_length=4)
    answer_index: int = Field(ge=0, le=3)
    explanation: str
    source: str = ""


class MCQs(BaseModel):
    questions: list[MCQ]


# Fronts/backs/questions are rendered as Markdown with LaTeX; spell out the forms that otherwise come back broken
ITEM_FORMAT = ("\n\nFormatting (all text fields are Markdown): write any table as a GitHub-flavoured Markdown table with a "
               "header row and a |---| separator row, on its own lines after a blank line; use $...$ for inline maths and "
               "$$...$$ for display maths; use - for bullet lists. Never write a table as plain lines of values.")
_OPTS_IN_Q = re.compile(r"\n\s*\(?A[.)]\s")


def _tidy_mcq(q: "MCQ") -> "MCQ":
    """Drop an A-D option list the model repeated at the end of the question text (the options are shown separately).
    Only cut when that tail really starts with the first option, so a question that merely mentions "A." is kept."""
    m = None
    for m in _OPTS_IN_Q.finditer(q.question):
        pass
    if m:
        tail = " ".join(q.question[m.end():].split()).lower()
        if tail.startswith(" ".join(q.options[0].split()).lower()[:30]):
            q.question = q.question[:m.start()].rstrip()
    return q


def _per_section(art, params, groups, total, prog, make_task, schema, pick):
    """Allocate `total` items across every section in scope (proportional to size) and generate each share."""
    sections = [(gi, s) for gi, g in enumerate(groups) for s in g["sections"]]
    shares = _allocate(total, [s["tokens"] for _, s in sections])
    items = []
    calls = [(gi, s, n) for (gi, s), n in zip(sections, shares) if n > 0]
    for k, (gi, sec, n) in enumerate(calls):
        prog(0.05 + 0.9 * k / len(calls), f"Section {k + 1}/{len(calls)}: {sec['title']}")
        system = _system(art["scope"], groups[gi])
        task = make_task(sec, n, [pick(i) for i in items][-60:]) + _focus_text(params) + _textbook(art["subject_id"], sec["title"], art["topic_id"])
        out = llm.chat_json([{"role": "system", "content": system}, {"role": "user", "content": task}], schema,
                            max_tokens=16000, reasoning=db.setting("generation_reasoning"), temperature=0.4)
        new = out.cards if isinstance(out, Cards) else out.questions
        seen = {pick(i).strip().lower() for i in items}
        items += [i for i in new if pick(i).strip().lower() not in seen]  # exact-text dedupe
    return items


def gen_flashcards(art, params, groups, prog):
    n = max(1, min(int(params.get("count") or 20), 200))
    def task(sec, k, existing):
        ex = ("\nAlready created (do not repeat): " + json.dumps(existing)) if existing else ""
        return (f"Create exactly {k} high-quality flashcards from the document section '{sec['title']}' in the material. "
                "Cover its most important definitions, laws, formulas, relationships and facts. Fronts are clear questions or "
                "prompts; backs are concise, complete answers." + ITEM_FORMAT + ex)
    cards = _per_section(art, params, groups, n, prog, task, Cards, lambda c: c.front)
    for c in cards:  # the slide/page that actually holds each card's answer (citations.py)
        c.source = citations.fix_source(c.source, f"{c.front} {c.back}", art["subject_id"])
    return {"cards": [c.model_dump() for c in cards]}


def gen_quiz(art, params, groups, prog):
    n = max(1, min(int(params.get("count") or 10), 60))
    def task(sec, k, existing):
        ex = ("\nAlready asked (do not repeat): " + json.dumps(existing)) if existing else ""
        return (f"Write exactly {k} multiple-choice questions from the document section '{sec['title']}' in the material. "
                "Each has 4 plausible options, exactly one correct, and an explanation of why it is right and why the "
                "others are wrong. Put the options only in 'options', never listed inside the question text."
                + ITEM_FORMAT + ex)
    qs = _per_section(art, params, groups, n, prog, task, MCQs, lambda q: q.question)
    for q in qs:  # the slide/page that actually holds the answer (citations.py)
        right = q.options[q.answer_index] if 0 <= q.answer_index < len(q.options) else ""
        q.source = citations.fix_source(q.source, f"{q.question} {right} {q.explanation}", art["subject_id"])
    return {"questions": [_tidy_mcq(q).model_dump() for q in qs]}


# ---------------------------------------------------------------- notes & cheat sheet

def _page_call(system, task, reasoning, page_tokens) -> tuple[str, str]:
    """(text, finish_reason). With reasoning on, the thinking shares max_tokens with the page itself, so it gets all
    the room the context window has left (at high effort the thinking alone can use well over 10k tokens)."""
    room = int(llm.context_tokens()) - approx_tokens(system + task) - 1500
    max_tokens = page_tokens if reasoning == "off" else max(page_tokens, min(room, 48000))
    res = llm.chat([{"role": "system", "content": system}, {"role": "user", "content": task}],
                   max_tokens=max(2000, min(max_tokens, room)), reasoning=reasoning, temperature=0.3)
    return llm.strip_think(res["content"]), res["finish"]


def _page(system, task, art, prog, label, max_tokens=16000, allow_empty=False) -> dict | None:
    """One notes/cheat-sheet page: HTML from the component brief, then the figures it asked for.
    An empty or cut-off page (the model spent its budget thinking) is retried once with low reasoning; a page that's
    still empty fails the job rather than being saved blank (or is skipped, with `allow_empty`, for a later part
    that was told to add only what the earlier parts didn't cover)."""
    task = f"{task}\n\n{notehtml.DESIGN}"
    reasoning = db.setting("generation_reasoning")
    raw, finish = _page_call(system, task, reasoning, max_tokens)
    if len(raw) < 200 or (finish == "length" and "</" not in raw[-400:]):
        prog.message(f"{label}: the page came back {'empty' if len(raw) < 200 else 'cut off'}, retrying with less reasoning")
        raw2, _ = _page_call(system, task, "low" if reasoning not in ("off", "low") else "off", max_tokens)
        if len(raw2) > len(raw):
            raw = raw2
    if len(raw) < 200:
        if allow_empty:
            return None
        raise errors.AppError("APO-GEN-403", f"empty page for {label}", plain=(
            f"Apollo returned an empty page for {label.split(': ', 1)[-1]}. Try again, or lower "
            "'Generating flashcards, quizzes, exams, notes' reasoning in Settings."))
    content, is_html = notehtml.clean(raw)
    if not is_html:
        return {"markdown": content}
    prog.message(f"{label}: adding figures")
    return {"html": content, "figures": figures.resolve(art["subject_id"], content, limit=3)}


def _covered(pages: list[tuple[str, dict]], limit=4000) -> str:
    """Outline of the pages written so far (the most recent kept when it gets long), so the next page doesn't repeat them."""
    blocks = []
    for title, page in pages:
        lines = notehtml.outline(page.get("html") or page.get("markdown") or "")
        if lines:
            blocks.append(f"[{title}]\n" + "\n".join(lines))
    text = ""
    for b in reversed(blocks):
        if len(text) + len(b) > limit:
            break
        text = b + ("\n" + text if text else "")
    return text


def gen_notes(art, params, groups, prog):
    sections = [(gi, s) for gi, g in enumerate(groups) for s in g["sections"]]
    focus = (params.get("focus") or "").strip()
    out, written = [], []
    for k, (gi, sec) in enumerate(sections):
        label = f"Writing notes {k + 1}/{len(sections)}: {sec['title']}"
        prog(0.05 + 0.9 * k / len(sections), label)
        task = (f"Write comprehensive, visually clear study notes for the document section '{sec['title']}', as a page "
                "of the student's notebook. Follow the material's structure with <h2>/<h3> headings. Include every "
                "definition (def), law and formula (formula, with symbols and units), turn the material's diagrams "
                "into figures (or draw/plot them when that explains better), add worked examples where the material "
                "has calculations, flag exam tips and common mistakes, and finish with a callout key 'Summary' of the "
                "key points. Use ONLY this section's content; do not include content from other documents.")
        if focus:  # per section: a focus list must not pull the same topics into every page
            task += (f"\nThe student is focusing on: {focus}. Give extra depth to those topics where THIS section covers "
                     "them; never bring them in from other documents, and write the section's other content normally.")
        task += _extra_text(params)
        covered = _covered(written)
        if covered:
            task += ("\n\nEarlier pages of these notes already cover the following. Do not repeat their definitions, "
                     "formulas, tables or explanations: when this section treats the same idea, write only what it adds "
                     "(a new detail, example or angle) and refer back briefly ('see <page title>').\n" + covered)
        page = _page(_system(art["scope"], groups[gi]),
                     task + _textbook(art["subject_id"], sec["title"], art["topic_id"]), art, prog, label)
        out.append({"title": sec["title"], "topic": sec["topic"], **page})
        written.append((sec["title"], page))
    return {"sections": out}


def _group_title(g: dict) -> str:
    topics = list(dict.fromkeys(s["topic"] for s in g["sections"]))
    return ", ".join(topics[:3]) + (f" +{len(topics) - 3}" if len(topics) > 3 else "")


def gen_cheatsheet(art, params, groups, prog):
    """One page per material group. Later parts see an outline of the earlier ones and add only what is new, so a
    large scope (or a focus list every group touches) doesn't produce the same cheat sheet several times over."""
    out, written = [], []
    for gi, g in enumerate(groups):
        label = f"Writing cheat sheet {gi + 1}/{len(groups)}"
        prog(0.1 + 0.85 * gi / len(groups), label)
        task = ("Write a dense, scannable one-page cheat sheet for ALL the material above. Group it by topic in "
                "grid2/card blocks; every formula as a formula block (symbols and units); key definitions as def "
                "blocks; key relationships as a compact table; one callout warn with common mistakes. Short phrases, "
                "no filler. Use at most 2 figures or plots, only for the most important diagrams." + _focus_text(params))
        covered = _covered(written)
        if covered:
            task += (f"\n\nThis is part {gi + 1} of a cheat sheet split into parts because the material is large. The "
                     "earlier parts already cover the headings and terms below. Do NOT repeat them: no second copy of a "
                     "definition, formula, table or comparison listed here. For a topic already covered, add only facts "
                     "the earlier parts lack, under a heading like '<topic> (more)'; leave out topics with nothing new. "
                     "Spend the page on what this material adds.\n" + covered)
        page = _page(_system(art["scope"], g), task, art, prog, label, max_tokens=12000, allow_empty=gi > 0)
        if page is None:
            continue  # this part had nothing new
        title = f"Part {gi + 1} · {_group_title(g)}" if len(groups) > 1 else "Cheat sheet"
        out.append({"title": title, **page})
        written.append((title, page))
    return {"sections": out}


# ---------------------------------------------------------------- mind map

class MapNode(BaseModel):
    label: str = Field(description="2-6 words")
    note: str = Field(default="", description="optional one-line detail: a definition, formula ($...$) or example")
    source: str = Field(default="", description="'filename · unit label' this idea comes from")
    children: list["MapNode"] = []


class MindMap(BaseModel):
    central: str
    branches: list[MapNode]


def _prune(nodes: list[MapNode], depth: int) -> list[dict]:
    """Plain dicts, at most 4 levels below the centre (deeper levels the model sometimes adds would not fit)."""
    return [{"label": n.label.strip()[:80], "note": n.note.strip()[:300], "source": n.source.strip(),
             "children": _prune(n.children, depth + 1) if depth < 4 else []} for n in nodes if n.label.strip()]


def gen_mindmap(art, params, groups, prog):
    trees = []
    for gi, g in enumerate(groups):
        prog(0.1 + 0.85 * gi / len(groups), f"Mapping the material {gi + 1}/{len(groups)}" if len(groups) > 1 else "Mapping the material")
        task = ("Build a mind map of ALL the material above, showing how its ideas connect. The centre is the overall "
                "subject of this material. Use 4-8 main branches (the big themes, in the order the material teaches them), "
                "each with 2-6 children, going up to 3 levels deeper where the material has detail. Labels are 2-6 words; "
                "put a key definition, formula or example in `note` (one line), and the source of each idea in `source`."
                + _focus_text(params))
        res = llm.chat_json([{"role": "system", "content": _system(art["scope"], g)}, {"role": "user", "content": task}],
                            MindMap, max_tokens=12000, reasoning=db.setting("generation_reasoning"), temperature=0.3)
        trees.append(res)
    if len(trees) == 1:
        root = {"label": trees[0].central.strip()[:80], "note": "", "source": "", "children": _prune(trees[0].branches, 1)}
    else:  # one branch per group of material
        root = {"label": art["scope"].split(" › ")[-1], "note": "", "source": "",
                "children": [{"label": t.central.strip()[:80], "note": "", "source": "", "children": _prune(t.branches, 2)} for t in trees]}
    return {"mindmap": root}


# ---------------------------------------------------------------- exam

class BPPart(BaseModel):
    name: str
    instructions: str = ""
    question_type: str = Field(description="mcq | true_false | short | long | calculation | case_study | fill_blank | other")
    count: int = Field(ge=1)
    marks_each: float = Field(ge=0)
    subquestions_per_question: int = 0
    style_notes: str = Field(default="", description="command words, typical length, cognitive level, formatting")


class Blueprint(BaseModel):
    title: str
    time_minutes: int | None = None
    total_marks: float
    instructions: str = ""
    parts: list[BPPart]
    difficulty_profile: str
    subject_guess: str
    matches_subject: bool


class RubricPoint(BaseModel):
    point: str
    marks: float


class SubQ(BaseModel):
    prompt: str
    marks: float
    options: list[str] = Field(default=[], description="only for multiple-choice / true-false sub-questions")
    answer_index: int | None = None
    model_answer: str
    rubric: list[RubricPoint] = []


class ExamQ(BaseModel):
    type: str
    prompt: str
    marks: float
    options: list[str] = []
    answer_index: int | None = None
    model_answer: str = ""
    rubric: list[RubricPoint] = []
    stimulus: str = ""
    subquestions: list[SubQ] = []
    source: str = ""


class ExamQs(BaseModel):
    questions: list[ExamQ]


def _practice_exam_content(path: Path, subject_id: int):
    """Extract text (and page images for PDFs/images) from the practice exam. Not embedded, not added to topics."""
    data = path.read_bytes()
    digest = sha(data)
    with tempfile.TemporaryDirectory() as tmp:  # extracted images aren't kept: the page images below are what's sent
        units, _ = parse(path, Path(tmp), db.get_settings())
    text = "\n\n".join(f"[{u['label']}]\n{u['text']}" for u in units if u["text"].strip())
    images = []
    if path.suffix.lower() == ".pdf":
        images = [render_pdf_page(path, u["idx"], dpi=110) for u in units[:12]]
    elif path.suffix.lower() in IMAGE_EXTS:
        images = [data]
    # one row per subject and file: generating again from the same practice exam reuses it
    row = db.q1("SELECT id FROM practice_exams WHERE subject_id=? AND sha256=? ORDER BY id DESC LIMIT 1", (subject_id, digest))
    if row:
        db.ex("UPDATE practice_exams SET filename=?, text=?, created_at=? WHERE id=?", (path.name, text, time.time(), row["id"]))
        return row["id"], text, images
    pid = db.ex("INSERT INTO practice_exams(subject_id, filename, sha256, text, created_at) VALUES (?,?,?,?,?)",
                (subject_id, path.name, digest, text, time.time()))
    return pid, text, images


def _key_ok(item) -> bool:
    """Options come with an answer key that points at one of them (or the item has no options at all)."""
    if not item.options:
        return True
    return item.answer_index is not None and 0 <= item.answer_index < len(item.options)


def _similar(a: str, b: str, n=5) -> float:
    """Deterministic word n-gram overlap, used to reject questions that copy the practice exam."""
    def grams(s):
        w = re.findall(r"\w+", s.lower())
        return {tuple(w[i:i + n]) for i in range(max(0, len(w) - n + 1))}
    ga, gb = grams(a), grams(b)
    return len(ga & gb) / len(ga) if ga else 0.0


def gen_exam(art, params, groups, prog):
    path = Path(params.get("practice_exam_path") or "")
    if not path.is_file():
        raise ValueError("Practice exam file not found")
    difficulty = params.get("difficulty", "normal")
    prog(0.03, "Reading practice exam")
    pid, text, images = _practice_exam_content(path, art["subject_id"])
    topics = ", ".join(t["name"] for t in context.topics_in_scope(art["subject_id"], art["topic_id"]))

    prog(0.08, "Analysing exam structure")
    content = [{"type": "text", "text":
                f"This is a PRACTICE EXAM a student uploaded. The student studies: {art['scope']} (topics: {topics}).\n"
                "Extract its exact STRUCTURE as a blueprint: every part/section in order, the question type, how many "
                "questions, marks per question, sub-question structure (e.g. case studies), instructions, time allowed and "
                "total marks. Describe the difficulty profile (cognitive level, calculation depth, distractor quality, answer "
                "length) and style notes per part. Also say which subject the exam is about and whether it matches the "
                f"student's subject.\n\nExtracted text:\n{text}"}]
    content += [llm.image_part(img) for img in images]
    bp = llm.chat_json([{"role": "user", "content": content}], Blueprint, max_tokens=12000, reasoning=db.setting("generation_reasoning"), temperature=0.2)
    db.ex("UPDATE practice_exams SET blueprint=? WHERE id=?", (bp.model_dump_json(), pid))

    parts_out = []
    for pi, part in enumerate(bp.parts):
        shares = _allocate(part.count, [g["tokens"] for g in groups])
        qs: list[ExamQ] = []
        for gi, n in enumerate(shares):
            if n == 0:
                continue
            prog(0.15 + 0.8 * pi / len(bp.parts), f"Part {part.name}: writing {n} question(s)")
            sub = f" Each question has a shared stimulus and {part.subquestions_per_question} sub-questions." if part.subquestions_per_question else ""
            task = (f"Write {n} NEW exam question(s) for '{part.name}' of an exam with this blueprint:\n{part.model_dump_json()}\n"
                    f"Question type: {part.question_type}; {part.marks_each:g} marks each.{sub}\n"
                    f"Difficulty: {DIFFICULTY.get(difficulty, DIFFICULTY['normal'])}\n"
                    f"Overall difficulty profile of the practice exam: {bp.difficulty_profile}\n"
                    "Questions must test THIS student's material above, spread across different sections, and must be completely "
                    "different from the practice exam's questions (copy its style and format only, never its content).\n"
                    "MCQ/true-false: give options and answer_index. Written questions: give a model answer and a marking rubric "
                    "whose point marks add up to the question's marks. Case studies: put the scenario in 'stimulus' and the parts "
                    f"in 'subquestions' (multiple-choice sub-questions get their own options and answer_index).\n\nPractice exam text, for STYLE reference only:\n{text[:12000]}"
                    + _extra_text(params)
                    + _textbook(art["subject_id"], f"{part.name} {part.question_type} {art['scope']}", art["topic_id"]))
            out = llm.chat_json([{"role": "system", "content": _system(art["scope"], groups[gi])}, {"role": "user", "content": task}],
                                ExamQs, max_tokens=20000, reasoning=db.setting("generation_reasoning"), temperature=0.5)
            for q in out.questions[:n]:
                full = q.stimulus + " " + q.prompt + " " + " ".join(s.prompt for s in q.subquestions)
                if _similar(full, text) > 0.5:
                    continue  # copies the practice exam: drop
                # a multiple-choice item whose answer key names no option can't be marked: it is left out
                had_subs = bool(q.subquestions)
                q.subquestions = [s for s in q.subquestions if _key_ok(s)]
                if not _key_ok(q) or (had_subs and not q.subquestions):
                    continue
                q.marks = part.marks_each if not q.subquestions else sum(s.marks for s in q.subquestions)
                qs.append(q)
        parts_out.append({"name": part.name, "instructions": part.instructions, "type": part.question_type,
                          "questions": [q.model_dump() for q in qs]})
    total = sum(q["marks"] for p in parts_out for q in p["questions"])
    return {"blueprint": bp.model_dump(), "difficulty": difficulty, "practice_exam": path.name,
            "warning": None if bp.matches_subject else f"The practice exam looks like a {bp.subject_guess} exam; only its structure was used.",
            "parts": parts_out, "total_marks": total, "time_minutes": bp.time_minutes}


GENERATORS = {"flashcards": gen_flashcards, "quiz": gen_quiz, "notes": gen_notes, "cheatsheet": gen_cheatsheet, "exam": gen_exam,
              "mindmap": gen_mindmap}


def run_artifact(artifact_id: int, job):
    art = db.q1("SELECT * FROM artifacts WHERE id=?", (artifact_id,))
    if art is None or art["deleted_at"]:  # deleted while its job waited: nothing to make
        raise pipeline.Cancelled()
    params = json.loads(art["params"])
    art["scope"] = context.scope_label(art["subject_id"], art["topic_id"])
    if params.get("document_ids"):
        names = [d["filename"] for d in db.q(f"SELECT filename FROM documents WHERE id IN ({','.join('?' * len(params['document_ids']))})",
                                             tuple(params["document_ids"]))]
        if names:
            art["scope"] = f"{art['scope'].split(' (')[0].split(' › ')[0]} › {', '.join(names)}"
    db.ex("UPDATE artifacts SET status='running', error=NULL, updated_at=? WHERE id=?", (time.time(), artifact_id))
    prog = Progress(artifact_id, job)
    prog(0.01, "Collecting material")
    doc_ids = params.get("document_ids") or None
    groups = context.material_groups(art["subject_id"], art["topic_id"], _gen_budget(), doc_ids)
    if not groups:
        raise ValueError(context.material_problem(art["subject_id"], art["topic_id"], doc_ids) or "No readable material in this scope.")
    content = GENERATORS[art["type"]](art, params, groups, prog)
    if _is_empty(art["type"], content):  # never saved as "ready" with nothing in it
        raise errors.AppError("APO-GEN-403", f"{art['type']} generation produced no items")
    db.ex("UPDATE artifacts SET status='ready', content=?, progress=1, message='Ready', updated_at=? WHERE id=?",
          (json.dumps(content), time.time(), artifact_id))


def _is_empty(kind: str, content: dict) -> bool:
    if kind == "flashcards":
        return not content.get("cards")
    if kind == "quiz":
        return not content.get("questions")
    if kind == "exam":
        return not any(p.get("questions") for p in content.get("parts", []))
    if kind == "mindmap":
        return not (content.get("mindmap") or {}).get("children")
    return not content.get("sections")


# ---------------------------------------------------------------- marking

class Mark(BaseModel):
    marks_awarded: float
    feedback: str
    missing_points: list[str] = []


def exam_leaves(content: dict):
    """Yields (key, label, question-like dict) for every answerable item, in order."""
    n = 0
    for pi, part in enumerate(content["parts"]):
        for qi, q in enumerate(part["questions"]):
            n += 1
            if q.get("subquestions"):
                for si, s in enumerate(q["subquestions"]):
                    yield f"p{pi}q{qi}s{si}", f"Q{n}{chr(97 + si)}", {**s, "type": q.get("type", "short"), "stimulus": q.get("stimulus", "")}
            else:
                yield f"p{pi}q{qi}", f"Q{n}", q


def run_marking(attempt_id: int, job):
    att = db.q1("SELECT * FROM attempts WHERE id=?", (attempt_id,))
    art = db.q1("SELECT * FROM artifacts WHERE id=?", (att["artifact_id"],)) if att else None
    if art is None or not art["content"]:  # the exam was deleted while this waited
        raise pipeline.Cancelled()
    content, answers = json.loads(art["content"]), json.loads(att["answers"])
    leaves = list(exam_leaves(content))
    results, score, total = {}, 0.0, 0.0
    for k, (key, label, q) in enumerate(leaves):
        job.check()
        msg = f"Marking {label} ({k + 1}/{len(leaves)})"
        job.update(k / len(leaves), msg)
        db.ex("UPDATE attempts SET progress=?, message=?, updated_at=? WHERE id=?", (k / len(leaves), msg, time.time(), attempt_id))
        ans = (answers.get(key) or "").strip()
        maxm = float(q.get("marks") or 0)
        total += maxm
        key_ok = isinstance(q.get("answer_index"), int) and 0 <= q["answer_index"] < len(q.get("options") or [])
        if q.get("options") and key_ok:
            # Multiple choice: checked exactly against the answer key.
            correct = ans != "" and ans.isdigit() and int(ans) == q["answer_index"]
            got = maxm if correct else 0.0
            results[key] = {"label": label, "marks_awarded": got, "max": maxm, "correct": correct,
                            "feedback": "Correct." if correct else f"Correct answer: {q['options'][q['answer_index']]}",
                            "missing_points": []}
        elif not ans:
            results[key] = {"label": label, "marks_awarded": 0.0, "max": maxm, "feedback": "No answer given.", "missing_points": []}
        else:
            rubric = "\n".join(f"- ({r['marks']:g}) {r['point']}" for r in q.get("rubric", [])) or "(no rubric: use the model answer)"
            task = (f"Mark this exam answer strictly and fairly against the rubric. Award marks per rubric point; partial "
                    f"credit only where the rubric allows. Maximum: {maxm:g} marks.\n\n"
                    + (f"Stimulus:\n{q['stimulus']}\n\n" if q.get("stimulus") else "")
                    + f"Question ({maxm:g} marks):\n{q['prompt']}\n\nModel answer:\n{q.get('model_answer', '')}\n\nRubric:\n{rubric}\n\n"
                    f"Student's answer:\n{ans}\n\nGive marks_awarded, specific feedback addressed to the student, and the rubric "
                    "points they missed.")
            m = llm.chat_json([{"role": "user", "content": task}], Mark, max_tokens=8000, reasoning=db.setting("marking_reasoning"), temperature=0.1)
            got = max(0.0, min(maxm, float(m.marks_awarded)))
            results[key] = {"label": label, "marks_awarded": got, "max": maxm, "feedback": m.feedback, "missing_points": m.missing_points}
        score += results[key]["marks_awarded"]
    db.ex("UPDATE attempts SET status='marked', result=?, score=?, total=?, progress=1, message='Marked', updated_at=? WHERE id=?",
          (json.dumps(results), score, total, time.time(), attempt_id))
