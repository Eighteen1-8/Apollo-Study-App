"""Checks the vision notes saved on units and flags the ones worth re-running, with the reason.

Two passes. `rule_scan` is deterministic and instant: leaked reasoning, cut-off output, generation loops, refusals,
broken LaTeX and units whose vision call failed (tuned on a real library so repeated table rows, headings and
currency amounts don't trip them). `review_document` (a job
in the vision lane) has Qwen look at the unit image, the extracted text and the notes, and judge whether the notes
are false or misleading, incomplete or malformed. That is the same model checking its own work, so its flags are
suggestions for the student to look at, not verdicts.

Flags live in `vision_flags`. Re-running vision on a unit clears its flags; dismissed flags are kept so a rescan
doesn't raise them again."""
import logging
import re
import time
from typing import Literal

from pydantic import BaseModel, Field

from . import config, db, llm

log = logging.getLogger(__name__)

KINDS = ("malformed", "incomplete", "misleading", "failed")

_META_START = re.compile(r"^\s*(okay|ok|alright|so)?[,.\s]*(let me|let's|i need to|i will|i'll|i should|the user (wants|is|has)|"
                         r"we need to|first,? i|hmm|wait)\b", re.I)
_REFUSAL = re.compile(r"\b(i (can ?not|can't|am unable to|'m unable to) (see|view|access|read|open) (the|any|this|your) "
                      r"(image|picture|attachment|file|slide|page)|no image (was|is|has been) (provided|attached|included))", re.I)


def _words(s: str) -> list[str]:
    return re.findall(r"\w+", s.lower())


def _ngrams(words: list[str], n: int) -> list[tuple]:
    return [tuple(words[i:i + n]) for i in range(len(words) - n + 1)]


def check_notes(notes: str | None) -> list[tuple[str, str]]:
    """Deterministic problems in one unit's finished, relevant notes: [(kind, reason)]."""
    from .pipeline import TRUNCATED
    notes = (notes or "").strip()
    out = []
    if len(notes) < 20:
        return [("malformed", "The description is empty or only a few characters long.")]
    if "<think>" in notes or "</think>" in notes:
        out.append(("malformed", "Contains the model's hidden reasoning (<think> tags) instead of only a description."))
    elif _META_START.match(notes):
        out.append(("malformed", "Starts with the model thinking aloud (\"Let me…\", \"The user wants…\") rather than describing the image."))
    if TRUNCATED in notes:
        out.append(("incomplete", "The output limit was reached, so the description stops part-way."))
    if _REFUSAL.search(notes[:300]):  # further in, it's usually transcribed text (a dialogue, a question)
        out.append(("misleading", "Says the model could not see the image, so it describes nothing that is actually there."))

    # A loop is the same sentence over and over in a row, or a long description that is mostly a copy of itself.
    # Table rows, headings like "Handwritten solution:" and blank answer lines legitimately repeat, but not back to
    # back as full sentences.
    run, best, prev = 0, 0, None
    for line in (l.strip() for l in notes.splitlines() if l.strip()):
        sentence = len(re.findall(r"[A-Za-z]{2,}", line)) >= 5 and not line.startswith("|")  # not table or matrix rows
        run = run + 1 if sentence and line == prev else 1
        best, prev = max(best, run if sentence else 0), line
    grams = _ngrams(_words(notes), 8)
    if best >= 3:
        out.append(("malformed", f"Repeats itself (a generation loop): the same line {best} times in a row."))
    elif len(grams) >= 300 and len(set(grams)) < 0.5 * len(grams):
        out.append(("malformed", "Repeats itself (a generation loop): most of the description appears twice or more."))

    if _stray_math_dollar(notes):
        out.append(("malformed", "Has an unmatched $ in its LaTeX, so the maths won't render and the text after it may display as maths."))
    return out


# How the app pairs delimiters when it renders notes (Markdown.tsx): $$...$$, then $...$ within a line.
_MATH = re.compile(r"\$\$.+?\$\$|\$[^$\n]+?\$", re.S)


def _stray_math_dollar(notes: str) -> bool:
    """A $ left over after pairing delimiters is only a problem with LaTeX right next to it: currency ($15), a lone $
    ("Cost ($)") or a $ key in `code` is plain text."""
    s = re.sub(r"`[^`\n]*`", lambda m: " " * len(m.group()), notes.replace("\\$", "S#"))  # \$ is a literal dollar (non-space, so "$\$5$" still pairs)
    rest = _MATH.sub(lambda m: " " * len(m.group()), s)
    return any(ch == "$" and not s[i + 1:i + 2].isdigit() and re.search(r"[\\^_{}]", s[max(0, i - 3):i] + s[i + 1:i + 13])
               for i, ch in enumerate(rest))


def rule_scan(doc_ids: list[int], unit_ids: list[int] | None = None) -> int:
    """Re-run the deterministic checks on these documents (or units), replacing their open rule flags. Returns the
    number of open rule flags. Units newly flagged as malformed lose their vision chunks (their notes aren't usable)."""
    if not doc_ids:
        return 0
    marks = ",".join("?" * len(doc_ids))
    where, args = f"document_id IN ({marks})", list(doc_ids)
    if unit_ids is not None:
        if not unit_ids:
            return 0
        where += f" AND id IN ({','.join('?' * len(unit_ids))})"
        args += unit_ids
    units = db.q(f"SELECT id, document_id, idx, vision_status, vision_notes, vision_relevant FROM units WHERE {where} "
                 "AND duplicate_of IS NULL AND vision_status IN ('done','failed')", args)
    dismissed = {(r["unit_id"], r["kind"]) for r in db.q(
        f"SELECT unit_id, kind FROM vision_flags WHERE document_id IN ({marks}) AND source='rule' AND dismissed=1", doc_ids)}
    now, count, drop = time.time(), 0, {}
    with db.tx() as c:
        for u in units:
            c.execute("DELETE FROM vision_flags WHERE unit_id=? AND source='rule' AND dismissed=0", (u["id"],))
            if u["vision_status"] == "failed":
                found = [("failed", "The vision call failed: " + (u["vision_notes"] or "unknown error").replace("[vision error] ", "", 1)[:400])]
            elif u["vision_relevant"]:
                found = check_notes(u["vision_notes"])
            else:
                found = []
            for kind, reason in found:
                if (u["id"], kind) in dismissed:
                    continue
                c.execute("INSERT INTO vision_flags(document_id, unit_id, kind, reason, source, created_at) VALUES (?,?,?,?,'rule',?)",
                          (u["document_id"], u["id"], kind, reason, now))
                count += 1
                if kind == "malformed":
                    drop.setdefault(u["document_id"], []).append(u["idx"])
        for did, idxs in drop.items():
            m = ",".join("?" * len(idxs))
            ids = f"SELECT id FROM chunks WHERE document_id=? AND source='vision' AND unit_start IN ({m})"
            c.execute(f"DELETE FROM chunks_fts WHERE rowid IN ({ids})", (did, *idxs))
            c.execute(f"DELETE FROM chunks WHERE id IN ({ids})", (did, *idxs))
    return count


AUDIT_SYSTEM = """You check descriptions of study material that a vision model wrote for a student who cannot see the image.
You get the page/slide image, the text extracted from it, and the description. Judge only the description.
Verdicts:
- ok: accurate and usable. Small omissions and style issues are fine.
- misleading: says something false or not visible: wrong values, labels, units, components, connections, trends or equations, or made-up details. Also use this when the visuals were judged decorative ("IRRELEVANT") but carry learning content (a graph, diagram, table, handwriting or worked steps).
- incomplete: leaves out an important visual the student needs, or stops part-way.
- malformed: not a usable description: the model's reasoning or notes to itself, repeated text, broken formatting or LaTeX, a refusal, or the wrong language.
Be strict about facts and lenient about style. The reason names the specific problem in one or two sentences, e.g. "Says the current is 2 A; the diagram shows 0.5 A." For ok, the reason may be empty."""


class Verdict(BaseModel):
    verdict: Literal["ok", "misleading", "incomplete", "malformed"]
    reason: str = Field("", description="The specific problem, one or two sentences")


def review_candidates(doc_id: int, recheck=False) -> list[dict]:
    """Units the model review would look at: finished vision (relevant or judged decorative) not yet reviewed, minus
    units the rules already flagged as malformed or failed (re-running them is the answer either way)."""
    return db.q(f"""SELECT u.* FROM units u WHERE u.document_id=? AND u.duplicate_of IS NULL AND u.needs_vision=1
                    AND u.vision_status='done' {'' if recheck else 'AND u.vision_audited=0'}
                    AND NOT EXISTS (SELECT 1 FROM vision_flags f WHERE f.unit_id=u.id AND f.source='rule' AND f.dismissed=0
                                    AND f.kind IN ('malformed','failed')) ORDER BY u.idx""", (doc_id,))


def review_document(doc_id: int, job, recheck=False):
    import json

    from .pipeline import Cancelled, unit_images
    doc = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if doc is None:
        return
    units = review_candidates(doc_id, recheck)
    reasoning = db.setting("audit_reasoning")
    dismissed = {r["unit_id"] for r in db.q("SELECT unit_id FROM vision_flags WHERE document_id=? AND source='model' AND dismissed=1", (doc_id,))}
    errors = 0
    for k, u in enumerate(units):
        job.check()
        job.update(k / max(len(units), 1), f"Checking vision notes: {u['label']} ({k + 1}/{len(units)})")
        try:
            if u["vision_image"] and (config.assets_dir() / u["vision_image"]).exists():
                images = [(config.assets_dir() / u["vision_image"]).read_bytes()]
            else:
                u["images"] = json.loads(u["images"])
                images = unit_images(doc, u)
            notes = u["vision_notes"] if u["vision_relevant"] else "IRRELEVANT (the vision model judged every visual decorative)"
            content = [{"type": "text", "text": f"Source: {doc['filename']}, {u['label']}\n\nExtracted text:\n{u['text'] or '(none)'}"
                                                f"\n\nDescription to check:\n<<<\n{notes}\n>>>"}]
            content += [llm.image_part(img) for img in images]  # type read from the bytes (llm.model_image)
            v = llm.chat_json([{"role": "system", "content": AUDIT_SYSTEM}, {"role": "user", "content": content}], Verdict,
                              max_tokens=6000, reasoning=reasoning, temperature=0)
        except Cancelled:
            raise
        except Exception:
            log.warning("vision review of unit %s failed", u["id"], exc_info=True)
            errors += 1
            continue
        with db.tx() as c:
            c.execute("DELETE FROM vision_flags WHERE unit_id=? AND source='model' AND dismissed=0", (u["id"],))
            if v.verdict != "ok" and u["id"] not in dismissed:
                c.execute("INSERT INTO vision_flags(document_id, unit_id, kind, reason, source, created_at) VALUES (?,?,?,?,'model',?)",
                          (doc_id, u["id"], v.verdict, v.reason.strip() or "No reason given.", time.time()))
            c.execute("UPDATE units SET vision_audited=1 WHERE id=?", (u["id"],))
    if errors:
        job.update(1, f"{errors} unit(s) could not be checked")
