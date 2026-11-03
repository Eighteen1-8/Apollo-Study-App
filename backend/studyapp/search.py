"""Hybrid retrieval: FTS5 BM25 + cosine over stored embeddings, fused with reciprocal rank fusion.
Chunks are extracted text or a unit's vision notes (source='vision'). Every result carries the vision notes of the
units it spans; a vision hit becomes its unit (extracted text + notes). Each unit's notes appear once per search."""
import re

import numpy as np

from . import db, llm

RRF_K = 60


def scope_documents(topic_id=None, subject_id=None, include_reference=True) -> list[int]:
    if topic_id is not None:
        t = db.q1("SELECT subject_id FROM topics WHERE id=?", (topic_id,))
        ids = [r["id"] for r in db.q("SELECT id FROM documents WHERE topic_id=?", (topic_id,))]
        subject_id = t["subject_id"] if t else None
        if include_reference and subject_id is not None:
            ids += [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind='reference'", (subject_id,))]
        return ids
    return [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=?", (subject_id,))]


def _fts_query(q):
    terms = [t for t in re.findall(r"\w+", q.lower()) if len(t) > 1]
    return " OR ".join(f'"{t}"' for t in terms)


def search(query: str, doc_ids: list[int], k=10):
    if not doc_ids or not query.strip():
        return []
    marks = ",".join("?" * len(doc_ids))
    ranks: dict[int, dict] = {}

    fq = _fts_query(query)
    if fq:
        rows = db.q(f"SELECT c.id FROM chunks_fts f JOIN chunks c ON c.id=f.rowid WHERE chunks_fts MATCH ? "
                    f"AND c.document_id IN ({marks}) ORDER BY bm25(chunks_fts) LIMIT 50", (fq, *doc_ids))
        for r, row in enumerate(rows):
            ranks.setdefault(row["id"], {})["bm25_rank"] = r + 1

    # Only vectors from the current model are comparable (a different model may not even have the same size).
    rows = db.q(f"SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL AND embed_model=? AND document_id IN ({marks})",
                (llm.embed_model(), *doc_ids))
    if rows and not llm.paused("embed"):  # paused embedding model: keyword matches only
        mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
        qv = llm.embed([query], query=True)[0]
        sims = mat @ qv
        for r, i in enumerate(np.argsort(-sims)[:50]):
            ranks.setdefault(rows[i]["id"], {}).update(vector_rank=r + 1, similarity=float(sims[i]))

    for cid, d in ranks.items():
        d["score"] = sum(1 / (RRF_K + d[key]) for key in ("bm25_rank", "vector_rank") if key in d)
    out, shown = [], set()  # shown: (document, unit) whose notes are already in a result
    for cid, d in sorted(ranks.items(), key=lambda kv: -kv[1]["score"]):
        if len(out) >= k:
            break
        c = db.q1("SELECT c.*, d.filename, d.kind AS doc_kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?", (cid,))
        vision = c["source"] == "vision"
        if vision and (c["document_id"], c["unit_start"]) in shown:
            continue  # an earlier result already carries this unit's notes
        notes = db.q("SELECT idx, label, vision_notes FROM units WHERE document_id=? AND idx BETWEEN ? AND ? "
                     "AND vision_status='done' AND vision_relevant=1 ORDER BY idx", (c["document_id"], c["unit_start"], c["unit_end"]))
        notes = [n for n in notes if (c["document_id"], n["idx"]) not in shown]
        shown.update((c["document_id"], n["idx"]) for n in notes)
        text, label = c["text"], c["label"]
        if vision:
            u = db.q1("SELECT label, text FROM units WHERE document_id=? AND idx=?", (c["document_id"], c["unit_start"]))
            text, label = u["text"] if u else "", u["label"] if u else label
        out.append({"chunk_id": cid, "document_id": c["document_id"], "filename": c["filename"], "doc_kind": c["doc_kind"],
                    "label": label, "text": text, "source": c["source"], "unit_start": c["unit_start"], "unit_end": c["unit_end"],
                    "vision_notes": [{"label": n["label"], "vision_notes": n["vision_notes"]} for n in notes], **d})
    return out
