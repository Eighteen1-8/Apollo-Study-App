"""Hybrid retrieval: FTS5 BM25 + cosine over stored embeddings, fused with reciprocal rank fusion.
Chunks are extracted text or a unit's vision notes (source='vision'). Every result carries the vision notes of the
units it spans; a vision hit becomes its unit (extracted text + notes). Each unit's notes appear once per search.

Vectors are kept in memory (`_vectors`), one float32 matrix per document, so a question doesn't decode every BLOB in
scope again. A scope is searched document by document and the similarities joined, never by copying its matrices into
one (that doubled the memory: measured faster too, 5 ms against 7 ms over 11k chunks of 4,096 dims). float16 would
halve memory again but made each search 15-30 times slower, so it isn't used. An entry is reused while its signature
(`_signatures`) is unchanged; SQLite triggers change it on every add, rebuild or re-embed. The least recently used are
dropped past CACHE_BYTES."""
import logging
import re
import threading
from collections import OrderedDict

import numpy as np

from . import db, llm

log = logging.getLogger(__name__)

RRF_K = 60
CACHE_BYTES = 512 << 20
_docs: "OrderedDict[tuple, tuple]" = OrderedDict()  # (doc_id, model) -> (signature, chunk ids, matrix)
_cache_lock = threading.Lock()


def _signatures(doc_ids: list[int], model: str) -> dict[int, tuple]:
    """Per document with current-model vectors: its creation time and vec_version, which SQLite triggers bump on any
    chunk added, removed or re-embedded (db.MIGRATIONS 2). Creation time covers a deleted document's reused id."""
    marks = ",".join("?" * len(doc_ids))
    return {r["id"]: (r["created_at"], r["vec_version"]) for r in db.q(
        f"SELECT id, created_at, vec_version FROM documents WHERE id IN ({marks})", tuple(doc_ids))}


def _evict():
    while sum(v[2].nbytes for v in _docs.values() if v[2] is not None) > CACHE_BYTES and len(_docs) > 1:
        _docs.popitem(last=False)


def _vectors(doc_ids: list[int], model: str) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Per document with current-model vectors: (chunk ids, matrix), from the cache where it's current."""
    sigs = _signatures(doc_ids, model)
    ids, mats = [], []
    for did, sig in sigs.items():
        with _cache_lock:
            entry = _docs.get((did, model))
            if entry and entry[0] == sig:
                _docs.move_to_end((did, model))
        if not (entry and entry[0] == sig):
            rows = db.q("SELECT id, embedding FROM chunks WHERE document_id=? AND embedding IS NOT NULL AND embed_model=? ORDER BY id",
                        (did, model))
            entry = (sig, np.array([r["id"] for r in rows], dtype=int),
                     np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]) if rows else None)
            with _cache_lock:
                _docs[(did, model)] = entry
                _evict()
        if entry[2] is None:  # nothing embedded with this model (yet)
            continue
        ids.append(entry[1])
        mats.append(entry[2])
    dims = {m.shape[1] for m in mats}
    if len(dims) > 1:  # one model always gives one size; mixed sizes mean stale rows, keep the common one
        common = max(dims, key=lambda d: sum(m.shape[0] for m in mats if m.shape[1] == d))
        ids = [i for i, m in zip(ids, mats) if m.shape[1] == common]
        mats = [m for m in mats if m.shape[1] == common]
    return ids, mats


def similarities(doc_ids: list[int], model: str, qv: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(chunk ids, cosine similarity to the query vector) over these documents' current-model vectors."""
    ids, mats = _vectors(doc_ids, model)
    mats = [(i, m) for i, m in zip(ids, mats) if m.shape[1] == len(qv)]
    if not mats:
        return np.array([], dtype=int), np.zeros(0, dtype=np.float32)
    return np.concatenate([i for i, _ in mats]), np.concatenate([m @ qv for _, m in mats])


def scope_documents(topic_id=None, subject_id=None, include_reference=True) -> list[int]:
    if topic_id is not None:
        t = db.q1("SELECT subject_id FROM topics WHERE id=?", (topic_id,))
        ids = [r["id"] for r in db.q("SELECT id FROM documents WHERE topic_id=?", (topic_id,))]
        subject_id = t["subject_id"] if t else None
        if include_reference and subject_id is not None:
            ids += [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind='reference'", (subject_id,))]
        return ids
    return [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND kind<>'trash'", (subject_id,))]


def _fts_query(q):
    terms = [t for t in re.findall(r"\w+", q.lower()) if len(t) > 1]
    return " OR ".join(f'"{t}"' for t in terms)


def search(query: str, doc_ids: list[int], k=10, problems: list | None = None):
    """Top `k` passages. When the embedding model can't be used (server off, an error) the keyword matches are still
    returned, so chat and generation carry on with what they find; the reason is appended to `problems` if given."""
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
    if not llm.paused("embed"):  # paused embedding model: keyword matches only
        model = llm.embed_model()
        if db.q1(f"SELECT 1 FROM chunks WHERE document_id IN ({marks}) AND embedding IS NOT NULL AND embed_model=? LIMIT 1",
                 (*doc_ids, model)):
            try:
                qv = llm.embed([query], query=True)[0]
                chunk_ids, sims = similarities(doc_ids, model, qv)
            except Exception as e:  # keyword matches only, as when it is paused
                from . import errors
                err = errors.classify(e, "embed")
                log.warning("%s search: keyword matches only (%s)", err.code, err.technical or err.plain)
                if problems is not None:
                    problems.append(str(err))
                chunk_ids, sims = np.array([], dtype=int), np.zeros(0, dtype=np.float32)
            for r, i in enumerate(np.argsort(-sims)[:50]):
                ranks.setdefault(int(chunk_ids[i]), {}).update(vector_rank=r + 1, similarity=float(sims[i]))

    for cid, d in ranks.items():
        d["score"] = sum(1 / (RRF_K + d[key]) for key in ("bm25_rank", "vector_rank") if key in d)
    out, shown = [], set()  # shown: (document, unit) whose notes are already in a result
    for cid, d in sorted(ranks.items(), key=lambda kv: -kv[1]["score"]):
        if len(out) >= k:
            break
        c = db.q1("SELECT c.*, d.filename, d.kind AS doc_kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?", (cid,))
        if c is None:  # rebuilt or deleted since it was ranked (a file being read again)
            continue
        vision = c["source"] == "vision"
        if vision and (c["document_id"], c["unit_start"]) in shown:
            continue  # an earlier result already carries this unit's notes
        notes = db.q("SELECT idx, kind, label, vision_notes FROM units WHERE document_id=? AND idx BETWEEN ? AND ? "
                     "AND vision_status='done' AND vision_relevant=1 ORDER BY idx", (c["document_id"], c["unit_start"], c["unit_end"]))
        notes = [n for n in notes if (c["document_id"], n["idx"]) not in shown]
        shown.update((c["document_id"], n["idx"]) for n in notes)
        text, label = c["text"], c["label"]
        if vision:
            u = db.q1("SELECT label, text FROM units WHERE document_id=? AND idx=?", (c["document_id"], c["unit_start"]))
            text, label = u["text"] if u else "", u["label"] if u else label
        out.append({"chunk_id": cid, "document_id": c["document_id"], "filename": c["filename"], "doc_kind": c["doc_kind"],
                    "label": label, "text": text, "source": c["source"], "unit_start": c["unit_start"], "unit_end": c["unit_end"],
                    "vision_notes": [{"idx": n["idx"], "kind": n["kind"], "label": n["label"], "vision_notes": n["vision_notes"]}
                                     for n in notes], **d})
    return out
