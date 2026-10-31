"""Hybrid retrieval: FTS5 BM25 + cosine over stored embeddings, fused with reciprocal rank fusion.
Results carry the vision notes of the units they span (not embedded, but shown/fed alongside)."""
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
    if rows:
        mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
        qv = llm.embed([query], query=True)[0]
        sims = mat @ qv
        for r, i in enumerate(np.argsort(-sims)[:50]):
            ranks.setdefault(rows[i]["id"], {}).update(vector_rank=r + 1, similarity=float(sims[i]))

    for cid, d in ranks.items():
        d["score"] = sum(1 / (RRF_K + d[key]) for key in ("bm25_rank", "vector_rank") if key in d)
    top = sorted(ranks.items(), key=lambda kv: -kv[1]["score"])[:k]

    out = []
    for cid, d in top:
        c = db.q1("SELECT c.*, d.filename, d.kind AS doc_kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?", (cid,))
        notes = db.q("SELECT label, vision_notes FROM units WHERE document_id=? AND idx BETWEEN ? AND ? "
                     "AND vision_status='done' AND vision_relevant=1 ORDER BY idx", (c["document_id"], c["unit_start"], c["unit_end"]))
        out.append({"chunk_id": cid, "document_id": c["document_id"], "filename": c["filename"], "doc_kind": c["doc_kind"],
                    "label": c["label"], "text": c["text"], "unit_start": c["unit_start"], "unit_end": c["unit_end"],
                    "vision_notes": notes, **d})
    return out
