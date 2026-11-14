"""Apollo checking or revising the student's notes and generated content (a 'review' job in the generate lane).

A review targets the student's own note (`user_notes`, target 'note') or a generated notes / cheat sheet artifact
(target 'artifact'), either whole or one highlighted passage (`quote`, in `section` for an artifact).
- check: is it correct according to the student's material? A verdict, a short summary and the wrong passages, each
  with a fix (structured output via llm.chat_json).
- revise: rewrite following the student's instruction (a comment on a highlight, or a request in chat). The result
  holds the proposed HTML per section; nothing changes until the student applies it (notes_api.apply_review), and an
  applied review keeps the previous HTML so it can be undone.

The material goes in the system prompt as for chat (the whole scope when it fits in one group, otherwise the passages
most related to the text under review), with textbook passages after it."""
import json
import logging
import re
import time
from typing import Literal

from lxml import html as lxml_html
from pydantic import BaseModel, Field

from . import citations, context, db, errors, figures, llm, notehtml

log = logging.getLogger(__name__)

UNCHANGED = "UNCHANGED"

CHECK_RULES = """You are Apollo, a careful study tutor checking the accuracy of study notes for a student studying {scope}.
Judge the TEXT TO CHECK against the STUDY MATERIAL below (the source of truth) and the textbook passages when given;
use well-established general knowledge only where the material is silent, and say so. Point out only real errors:
wrong facts, wrong formulas or units, wrong definitions, misleading or missing qualifications that change the meaning.
Do not nitpick style or wording. Each issue quotes the exact wrong words from the text (copied character for character,
short) and gives the corrected wording that should replace them, plus its source as [[filename · label]]."""

REVISE_RULES = """You are Apollo, editing study notes for a student studying {scope}, following the student's instruction.
The STUDY MATERIAL below is the source of truth: everything you add or change must agree with it. Keep the student's
structure, wording and formatting wherever the instruction doesn't ask for a change."""


MAX_ISSUES = 6  # a check lists only the errors that matter, most important first


class Issue(BaseModel):
    quote: str = Field(description="the exact wrong words, copied character for character, short")
    problem: str = Field(description="one or two short sentences: what is wrong, then why")
    fix: str = Field(description="the corrected wording that replaces the quote")
    source: str = Field(default="", description="where the material says so, as [[filename · unit label]]")


class Check(BaseModel):
    verdict: Literal["correct", "mostly_correct", "incorrect", "unsure"]
    summary: str = Field(description="one or two sentences for the student")
    issues: list[Issue] = Field(default=[], description=f"at most {MAX_ISSUES}, most important first")


# what a check asks for, after the material (so the cached system prompt stays the same)
CHECK_ASK = ("verdict: correct (no real errors), mostly_correct (small errors), incorrect (important errors) or unsure "
             "({unsure}). summary: one or two sentences for the student. issues: only the errors that matter, most "
             f"important first, at most {MAX_ISSUES} (empty when correct). Keep each issue short: problem is one or two "
             "sentences (what is wrong, then why), fix is the corrected wording. source cites the material the issue "
             "relies on as [[filename · unit label]], exactly as the material names the slide, page or section; leave it "
             "empty only when the material doesn't cover it.")


def _sentences(text: str, n: int = 2, limit: int = 360) -> str:
    """At most n sentences when the text runs long (the model sometimes writes a paragraph)."""
    text = " ".join(str(text or "").split())
    if len(text) <= limit:
        return text
    parts = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text)
    return " ".join(parts[:n])


def tidy_check(res: Check, subject_id: int) -> dict:
    """A check's result, kept concise and with checked citations: at most MAX_ISSUES issues, short summary and problems,
    each source moved to the unit that supports it (citations.fix_source) and written as [[file · label]] so the
    Comments panel shows it as a link."""
    out = res.model_dump()
    out["summary"] = citations.verify(_sentences(out["summary"]), subject_id)[0]
    issues = []
    for iss in out["issues"][:MAX_ISSUES]:
        iss["problem"] = _sentences(iss["problem"])
        src = citations.CITE.search(iss["source"] or "")
        if src:
            fixed = citations.fix_source(f"{src.group(1)} · {src.group(2)}", f"{iss['problem']} {iss['fix']}", subject_id)
            iss["source"] = f"[[{fixed}]]"
        elif "·" in (iss["source"] or ""):
            fixed = citations.fix_source(iss["source"].strip("[] "), f"{iss['problem']} {iss['fix']}", subject_id)
            iss["source"] = f"[[{fixed}]]"
        else:
            iss["source"] = (iss["source"] or "").strip()
        issues.append(iss)
    out["issues"] = issues
    return out


def plain_text(html: str) -> str:
    if not html.strip():
        return ""
    try:
        root = lxml_html.fragment_fromstring(html, create_parent="div")
        for br in root.iter("br"):
            br.tail = "\n" + (br.tail or "")
        for el in root.iter("p", "div", "li", "h1", "h2", "h3", "h4", "tr"):
            el.tail = "\n" + (el.tail or "")
        text = root.text_content()
    except Exception:
        text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+", " ", text)).strip()


def _map_parts(data) -> tuple[dict, list[dict]]:
    """({node id: its text}, the links whose both ends exist) of a mind map's data."""
    data = data if isinstance(data, dict) else {}
    nodes = [n for n in data.get("nodes") or [] if isinstance(n, dict) and n.get("id") is not None]
    names = {n["id"]: (str(n.get("text") or "").strip() or "(empty box)") for n in nodes}
    edges = [e for e in data.get("edges") or [] if isinstance(e, dict) and e.get("from") in names and e.get("to") in names]
    return names, edges


def _link(names: dict, e: dict) -> str:
    label = str(e.get("label") or "").strip()
    return f"{names[e['from']]} → {names[e['to']]}" + (f" ({label})" if label else "")


def map_text(data) -> str:
    """A mind map / flowchart as text for the model: its boxes, then its links as "A → B (label)", then the boxes that
    aren't linked to anything."""
    names, edges = _map_parts(data)
    if not names:
        return ""
    linked = {e["from"] for e in edges} | {e["to"] for e in edges}
    out = ["Boxes:", *(f"- {t}" for t in names.values())]
    if edges:
        out += ["", "Links (an arrow from the first box to the second, with its label in brackets):",
                *(f"- {_link(names, e)}" for e in edges)]
    loose = [t for i, t in names.items() if i not in linked]
    if loose and edges:
        out += ["", "Boxes not linked to anything: " + "; ".join(loose)]
    return "\n".join(out)


def map_outline(data) -> str:
    """A mind map as an indented outline, following its links from the boxes nothing points to (for chat's
    read_content); a box reached again is named, not repeated."""
    names, edges = _map_parts(data)
    if not names:
        return "(An empty mind map.)"
    kids: dict = {}
    for e in edges:
        kids.setdefault(e["from"], []).append(e)
    pointed = {e["to"] for e in edges}
    seen: set = set()
    lines: list[str] = []

    def walk(nid, depth, label=""):
        lines.append("  " * depth + "- " + (f"({label}) " if label else "") + names[nid] + (" (see above)" if nid in seen else ""))
        if nid in seen:
            return
        seen.add(nid)
        for e in kids.get(nid, []):
            walk(e["to"], depth + 1, str(e.get("label") or "").strip())
    for nid in [i for i in names if i not in pointed] + list(names):  # roots first; then anything only in a cycle
        if nid not in seen:
            walk(nid, 0)
    return "\n".join(lines)


def note_sections(n: dict) -> list[dict]:
    """A student's note as review sections: [{title, html}] for a rich-text note; a map or drawing has `text` (what the
    model reads) instead of html, and `kind`."""
    kind = n.get("kind") or "note"
    if kind == "note":
        return [{"title": n["title"], "html": n["html"]}]
    try:
        data = json.loads(n["data"]) if isinstance(n.get("data"), str) else (n.get("data") or {})
    except ValueError:
        data = {}
    if kind == "map":
        return [{"title": n["title"], "html": "", "kind": "map", "text": map_text(data), "outline": map_outline(data)}]
    desc = str((data or {}).get("description") or "").strip()
    return [{"title": n["title"], "html": "", "kind": "drawing", "description": desc,
             "text": f"(A drawing called “{n['title']}”" + (f". The student says it shows: {desc})" if desc else ".)")}]


def marking_text(m: dict) -> str:
    """A marking (marking.gen_marking's content) as plain text for chat's read_content: score, what was marked, the
    summary, then each question or criterion's mark, feedback, corrections and the student's words."""
    num = lambda x: f"{float(x or 0):g}"  # noqa: E731
    out = [f"Score: {num(m.get('score'))} out of {num(m.get('out_of'))}"
           + (f" (scaled from {num(m['raw'].get('awarded'))} of {num(m['raw'].get('available'))} on the criteria)"
              if m.get("scaled") and isinstance(m.get("raw"), dict) else "")]
    if m.get("files"):
        out.append("Work marked: " + ", ".join(m["files"]))
    out.append(f"Marking guide: {m['rubric']}" if m.get("rubric") else "No marking guide (Apollo worked out the criteria).")
    out.append(f"Checked against: {m['material']}" if m.get("material") else "Not checked against the study material.")
    if m.get("overall"):
        out.append("\nOverall: " + str(m["overall"]).strip())
    for head, key in (("Strengths", "strengths"), ("To improve", "improvements")):
        if m.get(key):
            out.append(f"\n{head}:\n" + "\n".join(f"- {s}" for s in m[key]))
    for c in m.get("criteria") or []:
        out.append(f"\n## {c.get('label', '')}: {num(c.get('awarded'))} of {num(c.get('max'))} marks")
        for q in c.get("quotes") or []:
            out.append(f"Student's words{f' (page {q['page']})' if q.get('page') else ''}: “{q.get('text', '')}”")
        if c.get("feedback"):
            out.append(str(c["feedback"]).strip())
        if c.get("corrections"):
            out.append("Corrections:\n" + "\n".join(f"- {x}" for x in c["corrections"]))
    return "\n".join(out)


def section_text(sec: dict, outline: bool = False) -> str:
    """What a section says in plain text (a map's outline when `outline`)."""
    if sec.get("kind") == "map" and outline:
        return sec["outline"]
    return sec["text"] if "text" in sec else plain_text(sec["html"])


def target_sections(r: dict) -> tuple[dict, list[dict]]:
    """(owner row with subject_id/topic_id/title, sections [{title, html}]) for a review's target (see note_sections
    for maps and drawings)."""
    if r["target"] == "note":
        n = db.q1("SELECT * FROM user_notes WHERE id=? AND deleted_at IS NULL", (r["target_id"],))
        if n is None:
            raise errors.AppError("APO-DATA-504", "review target note is gone", plain="That note was deleted.")
        return n, note_sections(dict(n))
    a = db.q1("SELECT * FROM artifacts WHERE id=? AND deleted_at IS NULL", (r["target_id"],))
    if a is None or not a["content"]:
        raise errors.AppError("APO-DATA-504", "review target artifact is gone", plain="That content was deleted or isn't ready.")
    content = json.loads(a["content"])
    if a["type"] == "marking":  # read in chat only (never checked or revised: notes_api.REVIEWABLE_TYPES)
        return a, [{"title": a["title"], "html": "", "kind": "marking", "text": marking_text(content.get("marking") or {})}]
    secs = content.get("sections") or []
    return a, [{"title": s.get("title", ""), "html": s.get("html") if s.get("html") is not None else s.get("markdown", ""),
                "markdown": s.get("html") is None} for s in secs]


def _system(rules: str, owner: dict, query: str) -> str:
    sid, tid = owner["subject_id"], owner["topic_id"]
    out = rules.replace("{scope}", context.scope_label(sid, tid))
    groups = context.material_groups(sid, tid, int(llm.context_tokens() * 0.5))
    if len(groups) == 1:
        out += f"\n\n=== STUDY MATERIAL ===\n{groups[0]['text']}"
    elif groups:
        try:
            out += "\n\n=== STUDY MATERIAL (the passages most related to the text) ===\n" + context.retrieved_material(sid, tid, query[:2000])
        except Exception as e:  # embeddings offline
            log.warning("review: retrieval failed: %s", e)
    else:
        out += "\n\n(No study material has been uploaded for this scope; use well-established knowledge and say so.)"
    if not context.uses_reference_material(sid, tid):
        try:
            tb = context.textbook_passages(sid, query[:2000], k=4)
        except Exception:
            tb = ""
        if tb:
            from .chat_prompt import TEXTBOOK_RULE  # here: chat_prompt → study_api → jobs imports this module
            out += f"\n\n=== Textbook passages (authoritative reference) ===\n{tb}\n{TEXTBOOK_RULE}"
    return out


def _strip_think(s: str) -> str:
    return llm.strip_think(s)


# Pictures pasted into a note are stored inline as data: URIs; sent as they are, one photo is megabytes of base64 in the
# model's prompt. The model sees a short placeholder in their place and the pictures are put back in its revision.
_DATA_IMAGE = re.compile(r"data:image/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+", re.I)
_PLACEHOLDER = re.compile(r"apollo-image:(\d+)")


def hide_images(html: str) -> tuple[str, dict[str, str]]:
    """(html with each inline picture replaced by `apollo-image:N`, {placeholder: the data URI})."""
    images: dict[str, str] = {}

    def swap(m):
        key = f"apollo-image:{len(images) + 1}"
        images[key] = m.group(0)
        return key
    return _DATA_IMAGE.sub(swap, html), images


def restore_images(html: str, images: dict[str, str]) -> str:
    """The pictures back in place of their placeholders (one the model invented is left as it is)."""
    return _PLACEHOLDER.sub(lambda m: images.get(m.group(0), m.group(0)), html) if images else html


MAP_RULES = """This is the student's mind map / flowchart, written out as its boxes and then its links: "A → B (label)" is an
arrow from box A to box B, with the arrow's label in brackets. Check the boxes' wording and whether each link and its
label is true (a wrong cause, a wrong order of steps, a link that should go the other way). A missing link or box is an
issue only when its absence makes the map misleading. Each issue's quote is the exact text of one box, or one link written
exactly as "A → B" (without the label), copied character for character; fix says what the box or link should be."""

DRAWING_RULES = """The picture attached is the student's own drawing (a diagram, sketch or worked figure), drawn by hand in
the app. Judge what it shows against the study material: wrong labels, wrong directions or shapes, wrong values or
relationships. Ignore neatness and handwriting style. Each issue's quote is the words or label in the drawing the problem is
at (copied as written), or a short description of the part of the drawing (e.g. "the arrow from the battery") when it has
no words; fix says what it should be."""


def _no_vision(e: Exception) -> bool:
    """Whether a model error means it can't take pictures."""
    if isinstance(e, errors.AppError) and e.code not in ("APO-LLM-109", "APO-LLM-108", "APO-LLM-104"):
        return False
    low = f"{e} {getattr(e, 'technical', '')}".lower()
    return any(w in low for w in ("image", "vision", "multimodal", "modalit", "mmproj", "image_url"))


def _check_drawing(r: dict, owner: dict, sec: dict, reasoning, prog) -> dict:
    """Check with Apollo on a drawing: its stored PNG snapshot (notes_api.put_snapshot) goes to the model after the
    material, with the student's description of what it shows."""
    from .notes_api import snapshot_path  # here: notes_api imports jobs, which imports this module
    if r["mode"] != "check":
        raise errors.AppError("APO-APP-400", "revise on a drawing", plain="Apollo can check a drawing, but not redraw it.")
    path = snapshot_path(owner["id"])
    if not path.is_file():
        raise errors.AppError("APO-DATA-504", f"no snapshot at {path}", plain="The drawing's picture is missing. Press Check with Apollo again.")
    img, mime = llm.model_image(path.read_bytes(), 2048)
    desc = sec.get("description", "")
    query = " ".join(x for x in (owner["title"], desc, r["instruction"]) if x)
    system = _system(CHECK_RULES, owner, query)
    task = (f"=== DRAWING TO CHECK: {owner['title']} ===\n"
            + (f"The student says it shows: {desc}\n" if desc else "")
            + (f"The student's question about it: {r['instruction']}\n" if r["instruction"].strip() else "")
            + f"\n{DRAWING_RULES}\n\nIs this drawing correct according to the material? "
            + CHECK_ASK.format(unsure="the material doesn't cover it, or the picture can't be made out"))
    prog(0.2, "Apollo is looking at your drawing")
    try:
        res = llm.chat_json([{"role": "system", "content": system},
                             {"role": "user", "content": [{"type": "text", "text": task}, llm.image_part(img, mime)]}],
                            Check, max_tokens=12000, reasoning=reasoning, temperature=0.2)
    except Exception as e:
        if _no_vision(e):
            raise errors.AppError("APO-GEN-410", str(e)) from e
        raise
    return tidy_check(res, owner["subject_id"])


def run_review(review_id: int, job):
    r = db.q1("SELECT * FROM reviews WHERE id=?", (review_id,))
    if r is None:
        return

    def prog(frac, msg):
        job.check()
        job.update(frac, msg)
        db.ex("UPDATE reviews SET progress=?, message=?, updated_at=? WHERE id=?", (frac, msg, time.time(), review_id))

    db.ex("UPDATE reviews SET status='running', error=NULL, updated_at=? WHERE id=?", (time.time(), review_id))
    owner, secs = target_sections(r)
    idxs = [r["section"]] if r["section"] is not None and 0 <= r["section"] < len(secs) else list(range(len(secs)))
    reasoning = db.setting("review_reasoning")
    prog(0.05, "Reading your material")
    kind = secs[0].get("kind") if r["target"] == "note" else None
    if kind == "drawing":
        result = _check_drawing(r, owner, secs[0], reasoning, prog)
    elif r["mode"] == "check":
        if kind == "map":
            text = r["quote"].strip() or secs[0]["text"]
        else:
            text = r["quote"].strip() or "\n\n".join(f"## {secs[i]['title']}\n{plain_text(secs[i]['html'])}" for i in idxs)
        if not text.strip():
            raise errors.AppError("APO-GEN-401", "nothing to check", plain="There's nothing to check yet.")
        system = _system(CHECK_RULES, owner, text)
        where = f" (from “{secs[idxs[0]]['title']}”)" if r["quote"].strip() and len(secs) > 1 else ""
        task = ((f"=== MIND MAP TO CHECK: {owner['title']} ===\n{text[:40000]}\n=== END ===\n\n{MAP_RULES}\n\n") if kind == "map"
                else f"=== TEXT TO CHECK{where} ===\n{text[:40000]}\n=== END ===\n\n")
        task += ((f"The student's question about it: {r['instruction']}\n\n" if r["instruction"].strip() else "")
                 + "Is this text correct according to the material? " + CHECK_ASK.format(unsure="the material doesn't cover it"))
        prog(0.2, "Apollo is checking")
        res = llm.chat_json([{"role": "system", "content": system}, {"role": "user", "content": task}], Check,
                            max_tokens=12000, reasoning=reasoning, temperature=0.2)
        result = tidy_check(res, owner["subject_id"])
    else:
        if kind == "map":
            raise errors.AppError("APO-APP-400", "revise on a map", plain="Apollo can check a mind map, but not rewrite it.")
        if not r["instruction"].strip():
            raise errors.AppError("APO-APP-400", "revise without an instruction", plain="Say what Apollo should change.")
        query = r["quote"] or r["instruction"] + "\n" + "\n".join(plain_text(secs[i]["html"])[:600] for i in idxs)
        system = _system(REVISE_RULES, owner, query)
        out, comments = [], []
        for k, i in enumerate(idxs):
            s = secs[i]
            prog(0.1 + 0.85 * k / len(idxs), f"Revising {s['title'] or 'the note'}" + (f" ({k + 1}/{len(idxs)})" if len(idxs) > 1 else ""))
            fmt = ("Markdown" if s.get("markdown") else
                   "an HTML fragment using the same tags and classes as the original (no <html>, <body>, <style> or <script>, "
                   "no code fences; keep every [[...]] citation and $...$ maths as they are"
                   + ("; keep each <img> whose src is apollo-image:N exactly as it is, where it belongs" if "data:image/" in s["html"] else "")
                   + ")")
            shown, images = hide_images(s["html"])
            task = (f"=== CURRENT {'SECTION' if r['target'] == 'artifact' else 'NOTE'}: {s['title']} ===\n{shown}\n=== END ===\n\n"
                    + (f"The student highlighted this passage: “{r['quote']}”\nChange that passage (and only what must change "
                       f"with it).\n\n" if r["quote"].strip() else "")
                    + f"The student's instruction: {r['instruction']}\n\n"
                    f"Reply with two parts. First <comment>one or two sentences telling the student what you changed and why"
                    f"</comment>. Then the complete revised {'section' if r['target'] == 'artifact' else 'note'} as {fmt}."
                    + (f" If the instruction doesn't apply to this section, reply with only {UNCHANGED}." if len(idxs) > 1 else ""))
            room = int(llm.context_tokens()) - len(system) // 3 - len(task) // 3 - 1500
            raw = _strip_think(llm.chat([{"role": "system", "content": system}, {"role": "user", "content": task}],
                                        max_tokens=max(2000, min(room, 24000)), reasoning=reasoning, temperature=0.3)["content"])
            if raw.strip() == UNCHANGED or (len(idxs) > 1 and raw.strip().endswith(UNCHANGED) and len(raw) < 400):
                continue
            m = re.search(r"<comment>(.*?)</comment>", raw, re.S)
            comment = m.group(1).strip() if m else ""
            body = restore_images((raw[m.end():] if m else raw).strip(), images)
            if s.get("markdown"):
                new = {"index": i, "markdown": re.sub(r"^```\w*\n|\n```$", "", body).strip()}
            elif r["target"] == "artifact":
                cleaned, is_html = notehtml.clean(body)
                new = {"index": i, "html": cleaned} if is_html else {"index": i, "markdown": cleaned}
                if is_html:
                    new["figures"] = figures.resolve(owner["subject_id"], cleaned, limit=3)
            else:
                new = {"index": i, "html": notehtml.scrub(re.sub(r"^```\w*\n|\n```$", "", body).strip())}
            if len((new.get("html") or new.get("markdown") or "").strip()) < 20:
                raise errors.AppError("APO-GEN-403", "empty revision", plain="Apollo returned an empty revision. Try again, or word the instruction differently.")
            out.append(new)
            if comment:
                comments.append(comment if len(idxs) == 1 else f"{s['title']}: {comment}")
        if not out:
            raise errors.AppError("APO-GEN-403", "nothing changed", plain="Apollo found nothing to change for that instruction.")
        result = {"comment": " ".join(comments) or "Revised as asked.", "sections": out}
    db.ex("UPDATE reviews SET status='ready', result=?, progress=1, message='Ready', updated_at=? WHERE id=?",
          (json.dumps(result), time.time(), review_id))
