"""Builds the study material Qwen reads: extracted text plus the vision notes stored beside it.

Material is split into "groups" that each fit the context budget. A group's text is always rendered the same
way (same order, same formatting), so repeated calls on it hit ninfer's prefix cache."""
from . import db, search
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
    parts = [f"[{u['label']}]"]
    if u["text"].strip():
        parts.append(u["text"].strip())
    if u["vision_status"] == "done" and u["vision_relevant"] and u["vision_notes"]:
        parts.append(f"[Visual content, described by the vision model]\n{u['vision_notes'].strip()}")
    return "\n".join(parts)


def topic_documents(subject_id: int, topic_id: int | None) -> list[dict]:
    ids = [t["id"] for t in topics_in_scope(subject_id, topic_id)]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    return db.q(f"""SELECT d.*, t.name AS topic_name FROM documents d JOIN topics t ON t.id=d.topic_id
                    WHERE d.topic_id IN ({marks}) AND d.kind='topic' AND d.unit_count > 0
                    ORDER BY t.name COLLATE NOCASE, d.id""", tuple(ids))


def document_sections(doc: dict, budget: int) -> list[dict]:
    """A document's units rendered as text, split into pieces no larger than `budget` tokens."""
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


def material_groups(subject_id: int, topic_id: int | None, budget: int) -> list[dict]:
    """Pack all document sections in scope into groups of <= budget tokens. Each group: {sections, text, tokens}."""
    groups, cur = [], []
    for doc in topic_documents(subject_id, topic_id):
        for sec in document_sections(doc, budget):
            if cur and sum(s["tokens"] for s in cur) + sec["tokens"] > budget:
                groups.append(cur)
                cur = []
            cur.append(sec)
    if cur:
        groups.append(cur)
    return [{"sections": g, "text": "\n\n\n".join(s["text"] for s in g), "tokens": sum(s["tokens"] for s in g)} for g in groups]


def retrieved_material(subject_id: int, topic_id: int | None, query: str, k: int = 12) -> str:
    """Retrieval fallback when the scope doesn't fit in context: top chunks + their vision notes."""
    ids = [d["id"] for d in topic_documents(subject_id, topic_id)]
    return _format_hits(search.search(query, ids, k))


def textbook_passages(subject_id: int, query: str, k: int = 5) -> str:
    ids = [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind='reference' AND unit_count > 0", (subject_id,))]
    if not ids or not query.strip():
        return ""
    return _format_hits(search.search(query, ids, k))


def _format_hits(hits: list[dict]) -> str:
    out = []
    for h in hits:
        block = f"[{h['filename']} · {h['label']}]\n{h['text']}"
        for n in h["vision_notes"]:
            block += f"\n[Visual content on {n['label']}]\n{n['vision_notes']}"
        out.append(block)
    return "\n\n".join(out)
