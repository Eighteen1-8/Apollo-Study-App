"""Builds the study material Qwen reads: extracted text plus the vision notes stored beside it.

Material is split into "groups" that each fit the context budget. A group's text is always rendered the same
way (same order, same formatting), so repeated calls on it hit ninfer's prefix cache."""
from . import db, search
from .citations import cite_label
from .parsers import approx_tokens


def topics_in_scope(subject_id: int, topic_id: int | None) -> list[dict]:
    if topic_id is not None:
        return db.q("SELECT * FROM topics WHERE id=? AND subject_id=?", (topic_id, subject_id))
    return db.q("SELECT * FROM topics WHERE subject_id=? ORDER BY name COLLATE NOCASE", (subject_id,))


def scope_label(subject_id: int, topic_id: int | None) -> str:
    s = db.q1("SELECT name FROM subjects WHERE id=?", (subject_id,))
    t = db.q1("SELECT name FROM topics WHERE id=?", (topic_id,)) if topic_id else None
    return f"{s['name']} › {t['name']}" if t else f"{s['name']} (all topics)"


def _unit_block(u: dict) -> str:
    parts = [f"[{cite_label(u)}]"]  # unique within the file, so a citation names exactly one unit (citations.py)
    if u["text"].strip():
        parts.append(u["text"].strip())
    if u["vision_status"] == "done" and u["vision_relevant"] and u["vision_notes"]:
        parts.append(f"[Visual content, described by the vision model]\n{u['vision_notes'].strip()}")
    return "\n".join(parts)


REFERENCE_LABEL = "Reference library"


def norm_units(units) -> dict[int, list[int]] | None:
    """A page/slide selection ({doc_id: [unit idx, ...]}, keys may be strings after JSON) as sorted ints; None when empty."""
    if not units:
        return None
    return {int(k): sorted({int(i) for i in v}) for k, v in units.items()}


def ranges_text(idxs: list[int]) -> str:
    """[3, 4, 5, 7, 12, 13] -> "3–5, 7, 12–13"."""
    out, run = [], []
    for i in sorted(set(idxs)):
        if run and i == run[-1] + 1:
            run.append(i)
            continue
        if run:
            out.append(f"{run[0]}–{run[-1]}" if len(run) > 1 else str(run[0]))
        run = [i]
    if run:
        out.append(f"{run[0]}–{run[-1]}" if len(run) > 1 else str(run[0]))
    return ", ".join(out)


def topic_documents(subject_id: int, topic_id: int | None, doc_ids: list[int] | None = None,
                    units: dict[int, list[int]] | None = None) -> list[dict]:
    """The scope's study material. A whole-subject scope whose topics hold no material (no topics yet, or only
    textbooks uploaded) falls back to the reference library, so a subject can be studied from its textbooks alone.
    `doc_ids` narrows the scope to those files of the subject (topic files or textbooks), e.g. "make content from
    this file"; a file in the trash is never material (a Regenerate after it was deleted finds nothing in it).
    `units` (chosen pages/slides, {doc_id: [idx]}) narrows it to the files they're in: any file of the subject for a
    whole-subject scope (textbooks too), the topic's files for a topic, or those of `doc_ids`."""
    if units:
        ids = [i for i in units if not doc_ids or i in doc_ids]
        if not ids:
            return []
        where = " AND d.topic_id=? AND d.kind='topic'" if topic_id is not None and not doc_ids else ""
        return db.q(f"""SELECT d.*, COALESCE(t.name, '{REFERENCE_LABEL}') AS topic_name FROM documents d
                        LEFT JOIN topics t ON t.id=d.topic_id
                        WHERE d.subject_id=? AND d.id IN ({','.join('?' * len(ids))}) AND d.kind<>'trash' AND d.unit_count > 0{where}
                        ORDER BY d.id""", (subject_id, *ids, *((topic_id,) if where else ())))
    if doc_ids:
        marks = ",".join("?" * len(doc_ids))
        return db.q(f"""SELECT d.*, COALESCE(t.name, '{REFERENCE_LABEL}') AS topic_name FROM documents d
                        LEFT JOIN topics t ON t.id=d.topic_id
                        WHERE d.subject_id=? AND d.id IN ({marks}) AND d.kind<>'trash' AND d.unit_count > 0 ORDER BY d.id""",
                    (subject_id, *doc_ids))
    ids = [t["id"] for t in topics_in_scope(subject_id, topic_id)]
    docs = []
    if ids:
        marks = ",".join("?" * len(ids))
        docs = db.q(f"""SELECT d.*, t.name AS topic_name FROM documents d JOIN topics t ON t.id=d.topic_id
                        WHERE d.topic_id IN ({marks}) AND d.kind='topic' AND d.unit_count > 0
                        ORDER BY t.name COLLATE NOCASE, d.id""", tuple(ids))
    if not docs and topic_id is None:
        docs = db.q("""SELECT d.*, ? AS topic_name FROM documents d WHERE d.subject_id=? AND d.kind='reference'
                       AND d.unit_count > 0 ORDER BY d.id""", (REFERENCE_LABEL, subject_id))
    return docs


def uses_reference_material(subject_id: int, topic_id: int | None) -> bool:
    """True when the scope's material is the reference library itself (then textbook passages would repeat it)."""
    docs = topic_documents(subject_id, topic_id)
    return bool(docs) and docs[0]["kind"] == "reference"


def material_problem(subject_id: int, topic_id: int | None, doc_ids: list[int] | None = None,
                     units: dict[int, list[int]] | None = None) -> str | None:
    """Why a scope has nothing to generate from, in words the student can act on; None when it has material."""
    if units:
        if material_groups(subject_id, topic_id, 10 ** 9, doc_ids, units):
            return None
        if not topic_documents(subject_id, topic_id, doc_ids, units):
            return "The pages you chose aren't in this material any more. Choose them again."
        return ("The pages you chose have no readable text yet. Choose other pages, wait until the file has finished being "
                "read, or run vision on it if its pages are pictures.")
    if any(d["token_count"] or d["vision_done"] for d in topic_documents(subject_id, topic_id, doc_ids)):
        return None
    if doc_ids:
        return ("That file has no readable material yet. Wait until it has finished being read (see background jobs), "
                "or run vision on it if its pages are pictures, then try again.")
    topic = db.q1("SELECT name FROM topics WHERE id=?", (topic_id,)) if topic_id else None
    where, args = ("topic_id=? AND kind='topic'", (topic_id,)) if topic_id else ("subject_id=?", (subject_id,))
    docs = db.q(f"SELECT status, unit_count, token_count FROM documents WHERE {where}", args)
    busy = sum(d["status"] not in ("ready", "failed", "cancelled") and not d["unit_count"] for d in docs)
    failed = sum(d["status"] in ("failed", "cancelled") for d in docs)
    name = f"The topic '{topic['name']}'" if topic else "This subject"
    if busy:
        return f"{name} has {busy} file(s) still being processed. Try again once they are ready (see background jobs)."
    if failed and failed == len(docs):
        return f"{name}'s files failed to ingest. Re-ingest them from the file's menu, then try again."
    if docs:
        return (f"{name}'s files have no readable text yet: their pages are images waiting for vision notes, or vision is "
                "off for them. Run vision on them (file menu), then try again.")
    if topic:
        return (f"{name} has no files yet. Upload files to it, or choose All topics to use the whole subject "
                "(including the reference library).")
    return "This subject has no files yet. Upload files to a topic or the reference library first."


def _chosen_units(doc_id: int, idxs: list[int], chosen: set[int]) -> list[dict]:
    """The chosen pages of a file. An exact duplicate of a page elsewhere is normally left out (its original is the
    material); when chosen, it's included (its text is stored) unless its original was chosen too, and it reads the
    original's vision notes (vision runs on originals only)."""
    if not idxs:
        return []
    rows = db.q(f"SELECT * FROM units WHERE document_id=? AND idx IN ({','.join('?' * len(idxs))}) ORDER BY idx", (doc_id, *idxs))
    out = []
    for u in rows:
        if u["duplicate_of"] is not None:
            if u["duplicate_of"] in chosen:
                continue
            orig = db.q1("SELECT vision_status, vision_relevant, vision_notes FROM units WHERE id=?", (u["duplicate_of"],))
            if orig and u["vision_status"] != "done":
                u = {**u, **orig}
        out.append(u)
    return out


def chosen_unit_ids(units: dict[int, list[int]] | None) -> set[int]:
    ids: set[int] = set()
    for did, idxs in (units or {}).items():
        if idxs:
            ids |= {r["id"] for r in db.q(f"SELECT id FROM units WHERE document_id=? AND idx IN ({','.join('?' * len(idxs))})",
                                          (did, *idxs))}
    return ids


def document_sections(doc: dict, budget: int, idxs: list[int] | None = None, chosen: set[int] | None = None) -> list[dict]:
    """A document's units rendered as text, split into pieces no larger than `budget` tokens. `idxs`: only those
    pages/slides (`chosen`: the unit ids of the whole selection, see _chosen_units)."""
    if idxs is not None:
        units = _chosen_units(doc["id"], idxs, chosen or set())
    else:
        units = db.q("SELECT * FROM units WHERE document_id=? AND duplicate_of IS NULL ORDER BY idx", (doc["id"],))
    header = f"=== Document: {doc['filename']} (topic: {doc['topic_name']}) ==="
    pieces, cur, cur_tok = [], [], 0
    for u in units:
        block = _unit_block(u)
        if block.count("\n") == 0:  # label only: nothing to read
            continue
        t = approx_tokens(block)
        if cur and cur_tok + t > budget:
            pieces.append(cur)
            cur, cur_tok = [], 0
        cur.append(block)
        cur_tok += t
    if cur:
        pieces.append(cur)
    out = []
    for i, p in enumerate(pieces, 1):
        title = doc["filename"] + (f" (part {i}/{len(pieces)})" if len(pieces) > 1 else "")
        text = (header if len(pieces) == 1 else f"{header} part {i}/{len(pieces)}") + "\n\n" + "\n\n".join(p)
        out.append({"doc_id": doc["id"], "title": title, "topic": doc["topic_name"], "text": text, "tokens": approx_tokens(text)})
    return out


def material_groups(subject_id: int, topic_id: int | None, budget: int, doc_ids: list[int] | None = None,
                    units: dict[int, list[int]] | None = None) -> list[dict]:
    """Pack all document sections in scope into groups of <= budget tokens. Each group: {sections, text, tokens}.
    `units`: only the chosen pages/slides ({doc_id: [idx]}, see topic_documents)."""
    groups, cur = [], []
    chosen = chosen_unit_ids(units) if units else None
    for doc in topic_documents(subject_id, topic_id, doc_ids, units):
        for sec in document_sections(doc, budget, units.get(doc["id"]) if units else None, chosen):
            if cur and sum(s["tokens"] for s in cur) + sec["tokens"] > budget:
                groups.append(cur)
                cur = []
            cur.append(sec)
    if cur:
        groups.append(cur)
    return [{"sections": g, "text": "\n\n\n".join(s["text"] for s in g), "tokens": sum(s["tokens"] for s in g)} for g in groups]


def retrieved_material(subject_id: int, topic_id: int | None, query: str, k: int = 12, seen: set | None = None) -> str:
    """Retrieval fallback when the scope doesn't fit in context: top chunks (text or vision notes) + their vision notes.
    `seen` collects the chunk ids given (the chat's search_material leaves them out)."""
    ids = [d["id"] for d in topic_documents(subject_id, topic_id)]
    hits = search.search(query, ids, k)
    if seen is not None:
        seen.update(h["chunk_id"] for h in hits)
    return _format_hits(hits)


def textbook_passages(subject_id: int, query: str, k: int = 5, seen: set | None = None) -> str:
    ids = [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind='reference' AND unit_count > 0", (subject_id,))]
    if not ids or not query.strip():
        return ""
    hits = search.search(query, ids, k)
    if seen is not None:
        seen.update(h["chunk_id"] for h in hits)
    return _format_hits(hits)


def _format_hits(hits: list[dict]) -> str:
    """Excerpts headed by their file only: a chunk's own label ("Slide 5 – Slide 6", "Outcome 2 (part 3)") names no
    single unit, and the model copied it into citations (38% of citations in real chats, 2026-11). The unit names inside
    each excerpt are the ones to cite, and Word sections get their number so repeated headings stay distinct."""
    out = []
    for h in hits:
        units = db.q("SELECT idx, kind, label FROM units WHERE document_id=? AND idx BETWEEN ? AND ? ORDER BY idx",
                     (h["document_id"], h["unit_start"], h["unit_end"]))
        text = h["text"]
        for u in units:
            if (name := cite_label(u)) != u["label"]:
                text = text.replace(f"[{u['label']}]", f"[{name}]", 1)
        if units and text.strip() and not text.lstrip().startswith("["):  # a vision hit's unit text carries no name
            text = f"[{cite_label(units[0])}]\n{text}"
        block = f"[From {h['filename']}]" + (f"\n{text}" if text.strip() else "")
        for n in h["vision_notes"]:
            block += f"\n[Visual content on {cite_label(n) if 'idx' in n else n['label']}]\n{n['vision_notes']}"
        out.append(block)
    return "\n\n".join(out)
