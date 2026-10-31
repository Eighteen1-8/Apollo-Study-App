"""3D projection of the stored chunk embeddings for the home page's knowledge cloud (display only).

PCA via SVD over the current embedding model's vectors; each axis is whitened and the cloud scaled so the
98th-percentile radius is 1. The result is cached until chunks are added, removed or the model changes."""
import numpy as np
from fastapi import APIRouter

from . import db

router = APIRouter()

MAX_POINTS = 3000
_cache: dict = {}


@router.get("/embeddings/map")
def embedding_map(limit: int = MAX_POINTS):
    limit = max(1, min(limit, MAX_POINTS))
    model = db.setting("embed_model")
    sig = db.q1("SELECT COUNT(*) n, COALESCE(MAX(id), 0) m FROM chunks WHERE embedding IS NOT NULL AND embed_model=?", (model,))
    key = (model, sig["n"], sig["m"], limit)
    if _cache.get("key") == key:
        return _cache["value"]

    rows = db.q("SELECT id, document_id, label, embedding FROM chunks WHERE embedding IS NOT NULL AND embed_model=? ORDER BY id",
                (model,))
    if len(rows) > limit:  # evenly spaced sample keeps every document represented
        rows = [rows[i] for i in np.linspace(0, len(rows) - 1, limit).astype(int)]

    points = []
    if len(rows) >= 4:
        mat = np.vstack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows]).astype(np.float64)
        mat /= np.linalg.norm(mat, axis=1, keepdims=True) + 1e-12
        mat -= mat.mean(axis=0)
        u, s, _ = np.linalg.svd(mat, full_matrices=False)
        xyz = u[:, :3] * s[:3]
        xyz /= xyz.std(axis=0) + 1e-12
        xyz /= np.percentile(np.linalg.norm(xyz, axis=1), 98) + 1e-12
        points = [[r["id"], r["document_id"], round(float(p[0]), 4), round(float(p[1]), 4), round(float(p[2]), 4), r["label"]]
                  for r, p in zip(rows, xyz)]

    doc_ids = sorted({p[1] for p in points})
    docs = {}
    if doc_ids:
        marks = ",".join("?" * len(doc_ids))
        for d in db.q(f"SELECT d.id, d.filename, d.kind, d.subject_id, d.topic_id, t.name topic FROM documents d "
                      f"LEFT JOIN topics t ON t.id=d.topic_id WHERE d.id IN ({marks})", doc_ids):
            docs[d["id"]] = {"filename": d["filename"], "kind": d["kind"], "subject_id": d["subject_id"],
                             "topic_id": d["topic_id"], "topic": d["topic"]}
    subjects = [dict(s) for s in db.q("SELECT id, name, color FROM subjects ORDER BY id")]

    value = {"model": model, "total": sig["n"], "points": points, "documents": docs, "subjects": subjects}
    _cache.update(key=key, value=value)
    return value
