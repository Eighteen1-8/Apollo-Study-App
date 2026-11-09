"""Citations: how a unit is named for the model, how a cited label is found again, and a deterministic check that
moves a citation to the slide/page that actually says what the sentence before it says.

Why (measured on real chats, 2026-11): three causes of "wrong slide/page" citations.
1. Word sections are named after their heading, and headings repeat ("Question 1", "Answer: B" in every exam), so a
   citation of "Answer: D" opened the first section with that heading. `cite_label` makes every unit's name unique
   ("Section 14 · Answer: D"); `find_unit` reads section numbers.
2. Retrieved excerpts were headed with their chunk's label ("Page 11 – Page 12", "Instructions (part 3)"), which the
   model copied into citations; neither names one unit. Excerpts now carry only unit names (context._format_hits).
3. The model sometimes cites the neighbouring slide, or a page it read in another excerpt. `verify` compares the claim
   (the text before each citation) with every unit of the cited file and moves the citation only when another unit
   clearly matches much better (thresholds chosen to leave correct citations alone).
"""
import logging
import re

from . import db

log = logging.getLogger(__name__)

CITE = re.compile(r"\[\[(?!\s*figure:)\s*([^\]|]+?)\s*·\s*([^\]|]+?)\s*\]\]", re.I)
_NUM = re.compile(r"^(slide|page|part|section)s?\s+(\d+)", re.I)
_RANGE = re.compile(r"^(?:slide|page|part|section)s?\s+(\d+)\s*[–—-]\s*(?:(?:slide|page|part|section)s?\s+)?(\d+)", re.I)
_WORD = re.compile(r"[a-zA-Z][a-zA-Z\-]{3,}")
_STOP = set("this that with from have which their there about into what when where these those your they will would should "
            "could also than then them been were being more most such only other very each over just like make made using used "
            "slide page section part material".split())
_norm = lambda s: re.sub(r"[^a-z0-9]+", " ", re.sub(r"\.(pdf|pptx|docx|txt|md|png|jpe?g)$", "", s.lower())).strip()  # noqa: E731


def cite_label(u: dict) -> str:
    """The unit's name as the model sees and cites it: unique within its file. Slides, pages and parts are already
    numbered; Word sections get their number in front of their heading."""
    label = u["label"]
    if u.get("kind") == "section" and not _NUM.match(label):
        return f"Section {u['idx']} · {label}"
    return label


def _words(t: str) -> set[str]:
    return {w.lower() for w in _WORD.findall(t or "") if w.lower() not in _STOP}


def candidates(units: list[dict], label: str) -> list[dict]:
    """Every unit the label could mean: one for a numbered label, a range's units for "Page 11 – Page 12", and all
    units sharing a heading for an old-style ambiguous section name."""
    l = re.sub(r"\s*\(part \d+\)$", "", label.strip(), flags=re.I)
    if m := _RANGE.match(l):
        a, b = sorted((int(m.group(1)), int(m.group(2))))
        return [u for u in units if a <= u["idx"] <= b]
    if m := _NUM.match(l):
        return [u for u in units if u["idx"] == int(m.group(2))]
    ll = l.lower()
    exact = [u for u in units if u["label"].lower() == ll]
    return exact or [u for u in units if u["label"].lower().startswith(ll) or ll.startswith(u["label"].lower())] \
        or [u for u in units if ll in u["label"].lower()]


def find_unit(units: list[dict], label: str) -> dict | None:
    c = candidates(units, label)
    return c[0] if c else None


def doc_for(subject_id: int, file: str) -> dict | None:
    docs = db.q("SELECT * FROM documents WHERE subject_id=? AND unit_count > 0 AND kind<>'trash'", (subject_id,))
    f = _norm(file)
    return next((d for d in docs if _norm(d["filename"]) == f), None) or next(
        (d for d in docs if _norm(d["filename"]).startswith(f) or f.startswith(_norm(d["filename"]))), None)


def _units(doc_id: int) -> list[dict]:
    return db.q("SELECT idx, kind, label, text, vision_notes FROM units WHERE document_id=? AND duplicate_of IS NULL ORDER BY idx",
                (doc_id,))


def best_unit(units: list[dict], claim: str, cited: list[dict]) -> tuple[dict | None, str]:
    """The unit the claim belongs to, or None to leave the citation as it is. Returns (unit, why)."""
    cw = _words(claim)
    if len(cw) < 5 or not units:
        return None, "claim too short to judge"
    score = lambda u: len(cw & _words(f"{u['text']} {u.get('vision_notes') or ''}")) / len(cw)  # noqa: E731
    ranked = sorted(units, key=score, reverse=True)
    best, sb = ranked[0], score(ranked[0])
    second = score(ranked[1]) if len(ranked) > 1 else 0.0
    sc = max((score(u) for u in cited), default=0.0)
    if cited and len(cited) == 1 and (sc >= 0.8 * sb or sc >= 0.5):
        return None, "cited unit supports the claim"
    if len(cited) > 1:  # a range or a repeated heading: settle on the one among them that matches
        among = max(cited, key=score)
        if score(among) >= 0.3:
            return among, "picked from an ambiguous label"
    # move only when another unit clearly matches: strong, well ahead of the cited one, and not a near-tie
    if sb >= 0.45 and sb - sc >= 0.25 and sb >= 2 * max(sc, 0.05) and sb > second * 1.15:
        return best, f"claim matches {best['label']!r} ({sb:.2f}) far better than the cited unit ({sc:.2f})"
    return None, "no clearly better unit"


def verify(text: str, subject_id: int) -> tuple[str, list[dict]]:
    """Check every [[file · label]] in a reply against the sentence before it. Returns the corrected text and what
    changed (also logged)."""
    out, last, changes = [], 0, []
    cache: dict[int, list[dict]] = {}
    for m in CITE.finditer(text):
        out.append(text[last:m.start()])
        file, label = m.group(1), m.group(2)
        new = m.group(0)
        doc = doc_for(subject_id, file)
        if doc:
            units = cache.setdefault(doc["id"], _units(doc["id"]))
            # the claim: what was written since the previous citation (at most a few sentences)
            claim = CITE.split(text[max(0, m.start() - 500):m.start()])[-1]
            cited = candidates(units, label)
            best, why = best_unit(units, claim, cited)
            if best is not None and not (len(cited) == 1 and best is cited[0]):
                new = f"[[{doc['filename']} · {cite_label(best)}]]"
                changes.append({"from": m.group(0), "to": new, "why": why})
            elif len(cited) == 1 and cite_label(cited[0]) != label and not _NUM.match(label):
                new = f"[[{doc['filename']} · {cite_label(cited[0])}]]"  # an old heading-only name: make it unambiguous
        out.append(new)
        last = m.end()
    out.append(text[last:])
    for c in changes:
        log.info("citation corrected: %s -> %s (%s)", c["from"], c["to"], c["why"])
    return "".join(out), changes


def fix_source(source: str, claim: str, subject_id: int) -> str:
    """The same check for a generated item's 'filename · label' source field (claim: the item's own text)."""
    if not source or "·" not in source:
        return source
    fixed, _ = verify(f"{claim} [[{source}]]", subject_id)
    m = CITE.search(fixed)
    return f"{m.group(1)} · {m.group(2)}" if m else source

