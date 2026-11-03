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
from pydantic import BaseModel

from . import context, db, figures, llm, notehtml

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


class Issue(BaseModel):
    quote: str
    problem: str
    fix: str
    source: str = ""


class Check(BaseModel):
    verdict: Literal["correct", "mostly_correct", "incorrect", "unsure"]
    summary: str
    issues: list[Issue] = []


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


def target_sections(r: dict) -> tuple[dict, list[dict]]:
    """(owner row with subject_id/topic_id/title, sections [{title, html}]) for a review's target."""
    if r["target"] == "note":
        n = db.q1("SELECT * FROM user_notes WHERE id=?", (r["target_id"],))
        if n is None:
            raise ValueError("That note was deleted.")
        return n, [{"title": n["title"], "html": n["html"]}]
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (r["target_id"],))
    if a is None or not a["content"]:
        raise ValueError("That content was deleted or isn't ready.")
    secs = json.loads(a["content"]).get("sections") or []
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
            out += f"\n\n=== Textbook passages (authoritative reference) ===\n{tb}"
    return out


def _strip_think(s: str) -> str:
    return re.sub(r"<think>.*?</think>", "", s, flags=re.S).strip()


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
    if r["mode"] == "check":
        text = r["quote"].strip() or "\n\n".join(f"## {secs[i]['title']}\n{plain_text(secs[i]['html'])}" for i in idxs)
        if not text.strip():
            raise ValueError("There's nothing to check yet.")
        system = _system(CHECK_RULES, owner, text)
        where = f" (from “{secs[idxs[0]]['title']}”)" if r["quote"].strip() and len(secs) > 1 else ""
        task = (f"=== TEXT TO CHECK{where} ===\n{text[:40000]}\n=== END ===\n\n"
                + (f"The student's question about it: {r['instruction']}\n\n" if r["instruction"].strip() else "")
                + "Is this text correct according to the material? verdict: correct (no real errors), mostly_correct "
                  "(small errors), incorrect (important errors) or unsure (the material doesn't cover it). summary: 1-3 "
                  "sentences for the student. issues: every real error (empty when correct).")
        prog(0.2, "Apollo is checking")
        res = llm.chat_json([{"role": "system", "content": system}, {"role": "user", "content": task}], Check,
                            max_tokens=12000, reasoning=reasoning, temperature=0.2)
        result = res.model_dump()
    else:
        if not r["instruction"].strip():
            raise ValueError("Say what Apollo should change.")
        query = r["quote"] or r["instruction"] + "\n" + "\n".join(plain_text(secs[i]["html"])[:600] for i in idxs)
        system = _system(REVISE_RULES, owner, query)
        out, comments = [], []
        for k, i in enumerate(idxs):
            s = secs[i]
            prog(0.1 + 0.85 * k / len(idxs), f"Revising {s['title'] or 'the note'}" + (f" ({k + 1}/{len(idxs)})" if len(idxs) > 1 else ""))
            fmt = ("Markdown" if s.get("markdown") else
                   "an HTML fragment using the same tags and classes as the original (no <html>, <body>, <style> or <script>, "
                   "no code fences; keep every [[...]] citation and $...$ maths as they are)")
            task = (f"=== CURRENT {'SECTION' if r['target'] == 'artifact' else 'NOTE'}: {s['title']} ===\n{s['html']}\n=== END ===\n\n"
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
            body = (raw[m.end():] if m else raw).strip()
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
                raise ValueError("Apollo returned an empty revision. Try again, or word the instruction differently.")
            out.append(new)
            if comment:
                comments.append(comment if len(idxs) == 1 else f"{s['title']}: {comment}")
        if not out:
            raise ValueError("Apollo found nothing to change for that instruction.")
        result = {"comment": " ".join(comments) or "Revised as asked.", "sections": out}
    db.ex("UPDATE reviews SET status='ready', result=?, progress=1, message='Ready', updated_at=? WHERE id=?",
          (json.dumps(result), time.time(), review_id))
