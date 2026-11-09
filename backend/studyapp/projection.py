"""3D projection of the stored chunk embeddings for the knowledge cloud (display only): the whole library on the
home page, or one subject (`subject_id`) as the default view of its workspace.

A subject gets its own axes, so they spread its own topics apart rather than separating it from other subjects.

- **Sample.** At most MAX_POINTS chunks per scope, picked by a hash of the chunk id. The pick is stable: adding
  chunks only swaps a few points in and out, so the rest of the cloud stays where it was.
- **Axes** (`cloud_axes`, one row per scope). The top 3 principal components, from a randomized range finder over at
  most FIT_ROWS sampled vectors (a full SVD of 3,000 × 4,096 took about 6 s; this takes well under one).
  - Each axis is whitened, and the cloud is scaled so the 98th-percentile radius is 1.
  - Signs are fixed (largest loading positive), so a refit doesn't mirror the cloud.
  - The axes are fitted once and kept. Refitting happens only when the scope has grown or shrunk by more than
    REFIT_DRIFT, the embedding model changed, or the student asks (`POST /embeddings/map/refit`).
- **Points** (`cloud_points`). Each sampled chunk's position on the stored axes is saved. Only chunks without one
  are read and projected, so an ingest adds points cheaply, and a restart reads no vectors at all.
- **Cache.** The finished response is kept in memory until the scope's chunks change."""
import time

import numpy as np
from fastapi import APIRouter

from . import db, llm

router = APIRouter()

MAX_POINTS = 3000
FIT_ROWS = 1500
REFIT_DRIFT = 0.25
_cache: dict = {}
_HASH = "((c.id * 2654435761) % 4294967296)"  # Knuth's multiplicative hash: a stable, well-spread order of ids


def _scope(subject_id: int | None) -> tuple[str, str, tuple]:
    """(scope key, extra WHERE for chunks aliased c, its args)."""
    if subject_id is None:
        return "all", " AND c.document_id NOT IN (SELECT id FROM documents WHERE kind='trash')", ()
    return (f"subject:{subject_id}", " AND c.document_id IN (SELECT id FROM documents WHERE subject_id=? AND kind<>'trash')",
            (subject_id,))


def _vectors(ids: list[int]) -> dict[int, np.ndarray]:
    out = {}
    for i in range(0, len(ids), 500):
        part = ids[i:i + 500]
        for r in db.q(f"SELECT id, embedding FROM chunks WHERE id IN ({','.join('?' * len(part))})", part):
            v = np.frombuffer(r["embedding"], dtype=np.float32)
            out[r["id"]] = v / (np.linalg.norm(v) + 1e-12)
    return out


def top_components(mat: np.ndarray, k: int = 3, oversample: int = 10, iters: int = 3, seed: int = 0) -> np.ndarray:
    """The top `k` right singular vectors of the (already centred) `mat`, as rows (k × dims), by a randomized range
    finder with power iterations (Halko et al.). Each axis's sign is fixed so its largest loading is positive."""
    n, d = mat.shape
    k = min(k, n, d)
    if k == 0:
        return np.zeros((0, d), dtype=np.float32)
    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(mat @ rng.standard_normal((d, min(k + oversample, n, d))).astype(mat.dtype))
    for _ in range(iters):
        q, _ = np.linalg.qr(mat.T @ q)
        q, _ = np.linalg.qr(mat @ q)
    _, _, vt = np.linalg.svd(q.T @ mat, full_matrices=False)
    axes = vt[:k]
    signs = np.sign(axes[np.arange(k), np.abs(axes).argmax(axis=1)])
    return (axes * np.where(signs == 0, 1, signs)[:, None]).astype(np.float32)


def _fit(scope: str, model: str, count: int, ids: list[int]) -> dict:
    """Fit and store the scope's axes from (at most FIT_ROWS of) the sampled chunks."""
    pick = ids if len(ids) <= FIT_ROWS else [ids[i] for i in np.linspace(0, len(ids) - 1, FIT_ROWS).astype(int)]
    vecs = _vectors(pick)
    mat = np.vstack([vecs[i] for i in pick if i in vecs]).astype(np.float32)
    mean = mat.mean(axis=0)
    mat -= mean
    axes = top_components(mat)
    xyz = np.zeros((len(mat), 3), dtype=np.float32)  # fewer than 3 components (a tiny scope): the rest stay 0
    xyz[:, :len(axes)] = mat @ axes.T
    std = xyz.std(axis=0)
    std = np.where(std > 1e-9, std, 1).astype(np.float32)
    radius = float(np.percentile(np.linalg.norm(xyz / std, axis=1), 98)) + 1e-12
    full = np.zeros((3, mat.shape[1]), dtype=np.float32)
    full[:len(axes)] = axes
    fit = {"mean": mean.astype(np.float32), "axes": full, "std": std, "radius": radius, "n": count}
    with db.tx() as c:
        c.execute("INSERT OR REPLACE INTO cloud_axes (scope, model, n_fit, mean, axes, std, radius, fitted_at) "
                  "VALUES (?,?,?,?,?,?,?,?)", (scope, model, count, fit["mean"].tobytes(), full.tobytes(),
                                                 std.tobytes(), radius, time.time()))
        c.execute("DELETE FROM cloud_points WHERE scope=?", (scope,))
    return fit


def _stored(scope: str, model: str) -> dict | None:
    r = db.q1("SELECT * FROM cloud_axes WHERE scope=? AND model=?", (scope, model))
    if not r:
        return None
    mean = np.frombuffer(r["mean"], dtype=np.float32)
    return {"mean": mean, "axes": np.frombuffer(r["axes"], dtype=np.float32).reshape(3, len(mean)),
            "std": np.frombuffer(r["std"], dtype=np.float32), "radius": r["radius"], "n": r["n_fit"]}


def refit(subject_id: int | None = None):
    """Forget a scope's axes and points; the next map request fits new ones."""
    scope = _scope(subject_id)[0]
    with db.tx() as c:
        c.execute("DELETE FROM cloud_axes WHERE scope=?", (scope,))
        c.execute("DELETE FROM cloud_points WHERE scope=?", (scope,))
    for k in [k for k in _cache if k[1] == subject_id]:
        del _cache[k]


@router.post("/embeddings/map/refit")
def refit_endpoint(subject_id: int | None = None):
    refit(subject_id)
    return {"ok": True}


@router.get("/embeddings/map")
def embedding_map(limit: int = MAX_POINTS, subject_id: int | None = None):
    limit = max(1, min(limit, MAX_POINTS))
    model = llm.embed_model()
    scope, where, args = _scope(subject_id)
    sig = db.q1(f"SELECT COUNT(*) n, COALESCE(MAX(c.id), 0) m, COALESCE(SUM(c.id), 0) s FROM chunks c "
                f"WHERE c.embedding IS NOT NULL AND c.embed_model=?{where}", (model, *args))
    key = (model, subject_id, sig["n"], sig["m"], sig["s"], limit)
    if key in _cache:
        return _cache[key]

    rows = db.q(f"SELECT c.id, c.document_id, c.label FROM chunks c WHERE c.embedding IS NOT NULL AND c.embed_model=?"
                f"{where} ORDER BY {_HASH} LIMIT ?", (model, *args, limit))
    rows.sort(key=lambda r: r["id"])
    ids = [r["id"] for r in rows]
    points = []
    if rows:
        fit = _stored(scope, model)
        if fit is None or abs(sig["n"] - fit["n"]) > REFIT_DRIFT * max(fit["n"], 1):
            fit = _fit(scope, model, sig["n"], ids)
        known = {}
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            for p in db.q(f"SELECT chunk_id, x, y, z FROM cloud_points WHERE scope=? AND chunk_id IN "
                          f"({','.join('?' * len(part))})", (scope, *part)):
                known[p["chunk_id"]] = (p["x"], p["y"], p["z"])
        new = [i for i in ids if i not in known]
        if new:
            vecs = _vectors(new)
            new = [i for i in new if i in vecs]
            if new:
                xyz = (np.vstack([vecs[i] for i in new]) - fit["mean"]) @ fit["axes"].T / fit["std"] / fit["radius"]
                added = [(scope, i, round(float(p[0]), 4), round(float(p[1]), 4), round(float(p[2]), 4))
                         for i, p in zip(new, xyz)]
                with db.tx() as c:
                    c.executemany("INSERT OR REPLACE INTO cloud_points (scope, chunk_id, x, y, z) VALUES (?,?,?,?,?)", added)
                known.update({a[1]: a[2:] for a in added})
        stored = db.q1("SELECT COUNT(*) n FROM cloud_points WHERE scope=?", (scope,))["n"]
        if stored > len(known):  # points of chunks no longer sampled (deleted, re-chunked, or swapped out)
            with db.tx() as c:
                c.execute(f"DELETE FROM cloud_points WHERE scope=? AND chunk_id NOT IN (SELECT c.id FROM chunks c "
                          f"WHERE c.embedding IS NOT NULL AND c.embed_model=?{where} ORDER BY {_HASH} LIMIT ?)",
                          (scope, model, *args, limit))
        points = [[r["id"], r["document_id"], *known[r["id"]], r["label"]] for r in rows if r["id"] in known]

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
    for k in [k for k in _cache if k[:2] == key[:2]]:  # one entry per scope
        del _cache[k]
    _cache[key] = value
    return value
