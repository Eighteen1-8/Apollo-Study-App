"""Settings → Maintenance: what each subject, topic and file takes on disk and in the index, leftovers to clean up,
re-embedding, and the vision notes audit (vision_audit.py) with re-running vision on the units it flags.

Scopes are a subject, a topic or one document (`ScopeBody`); a subject includes its reference library."""
import json
import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import config, db, jobs, llm, pipeline, render, vision_audit
from .parsers import PARSER_VERSION

router = APIRouter()


class ScopeBody(BaseModel):
    subject_id: int | None = None
    topic_id: int | None = None
    document_id: int | None = None


def _scope_docs(b: ScopeBody) -> list[int]:
    if b.document_id is not None:
        rows = db.q("SELECT id FROM documents WHERE id=?", (b.document_id,))
    elif b.topic_id is not None:
        rows = db.q("SELECT id FROM documents WHERE topic_id=?", (b.topic_id,))
    elif b.subject_id is not None:
        rows = db.q("SELECT id FROM documents WHERE subject_id=?", (b.subject_id,))
    else:
        rows = db.q("SELECT id FROM documents")
    return [r["id"] for r in rows]


def _tree_size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    total = 0
    for root, _, files in os.walk(p):
        for f in files:
            try:
                total += os.stat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


CHAT_GRACE = 7 * 24 * 3600  # a screenshot or attachment not sent yet may still be in the composer


def _referenced_assets() -> set[str]:
    """Shared assets (figures/..., chat/...) that saved messages, generated content or the figure cache point to."""
    refs = set()
    pat = re.compile(r"""(?:figures|chat)/[^\s"'<>)?\\]+""")
    for sql in ("SELECT meta || ' ' || content AS t FROM messages", "SELECT COALESCE(content, '') AS t FROM artifacts",
                "SELECT data AS t FROM figure_cache"):
        for r in db.q(sql):
            refs.update(pat.findall(r["t"] or ""))
    return refs


def _orphans() -> dict:
    """Files left behind on disk that no document, message or generated content uses any more."""
    docs = db.q("SELECT id, sha256, ext FROM documents")
    names, shas, ids = {f"{d['sha256']}{d['ext']}" for d in docs}, {d["sha256"] for d in docs}, {str(d["id"]) for d in docs}
    out = {"files": [], "renders": [], "assets": []}
    if config.files_dir().exists():
        out["files"] = [p for p in config.files_dir().iterdir() if p.is_file() and p.name not in names]
    out["renders"] = [p for p in render.renders_dir().iterdir() if p.is_file() and p.stem not in shas]
    if config.assets_dir().exists():  # per-document folders are named by document id; chat/, figures/ etc. are shared
        out["assets"] = [p for p in config.assets_dir().iterdir() if p.is_dir() and p.name.isdigit() and p.name not in ids]
    # caches: cropped figures and chat files nothing refers to, and folders older versions left from practice exams
    out["cache"] = []
    if config.assets_dir().exists():
        refs, old = _referenced_assets(), time.time() - CHAT_GRACE
        for folder in ("figures", "chat"):
            d = config.assets_dir() / folder
            if d.is_dir():
                out["cache"] += [p for p in d.iterdir() if p.is_file() and f"{folder}/{p.name}" not in refs
                                 and (folder == "figures" or p.stat().st_mtime < old)]
        out["cache"] += [p for p in config.assets_dir().iterdir() if p.is_dir() and p.name.startswith("practice_")]
        marking = config.assets_dir() / "marking"  # copies kept for a marking whose content is gone (e.g. its subject)
        if marking.is_dir():
            kept = {str(r["id"]) for r in db.q("SELECT id FROM artifacts WHERE type='marking'")}
            out["cache"] += [p for p in marking.iterdir() if p.is_dir() and p.name not in kept]
    return out


def _stale_rows() -> dict:
    """Database rows pointing at nothing: cached figures whose image is gone, screenshot records whose file is gone,
    and older copies of a practice exam (one per subject and file is kept)."""
    figures = [r["key"] for r in db.q("SELECT key, data FROM figure_cache")
               if not (config.assets_dir() / str(json.loads(r["data"]).get("asset") or "-")).exists()]
    snaps = [r["path"] for r in db.q("SELECT path FROM snapshots") if not Path(r["path"]).exists()]
    exams = [r["id"] for r in db.q("""SELECT id FROM practice_exams p WHERE id < (SELECT MAX(id) FROM practice_exams q
                                       WHERE q.subject_id=p.subject_id AND q.sha256=p.sha256)""")]
    return {"figure_cache": figures, "snapshots": snaps, "practice_exams": exams}


@router.get("/maintenance/overview")
def overview():
    model = llm.embed_model()
    docs = db.q("""SELECT d.id, d.subject_id, d.topic_id, d.kind, d.filename, d.ext, d.sha256, d.size, d.status, d.error,
                          d.unit_count, d.vision_total, d.vision_done, d.embed_model, d.parser_version, d.render_error, d.updated_at FROM documents d WHERE d.kind<>'trash' ORDER BY d.filename COLLATE NOCASE""")
    per = lambda sql: {r["document_id"]: r for r in db.q(sql, (model,) if "?" in sql else ())}
    chunks = per("""SELECT document_id, SUM(source='text') text_chunks, SUM(source='vision') vision_chunks,
                    SUM(embedding IS NULL OR embed_model IS NOT ?) unembedded,
                    SUM(LENGTH(text) + COALESCE(LENGTH(embedding), 0)) bytes FROM chunks GROUP BY document_id""")
    units = per("""SELECT document_id, SUM(vision_status='failed') vision_failed,
                   SUM(LENGTH(text) + COALESCE(LENGTH(vision_notes), 0)) bytes FROM units GROUP BY document_id""")
    flags = per("SELECT document_id, COUNT(*) flags FROM vision_flags WHERE dismissed=0 GROUP BY document_id")
    reviewing = {r["document_id"] for r in db.q("SELECT document_id FROM jobs WHERE type='audit' AND status IN ('queued','running')")}

    out = []
    for d in docs:
        c, u = chunks.get(d["id"], {}), units.get(d["id"], {})
        path = pipeline.doc_path(d)
        rendered = render.renders_dir() / f"{d['sha256']}.pdf"
        file_size = path.stat().st_size if path.exists() else 0
        render_size = rendered.stat().st_size if d["ext"] in render.OFFICE_EXTS and rendered.exists() else 0
        assets = config.assets_dir() / str(d["id"])
        asset_size = _tree_size(assets) if assets.exists() else 0
        index = (c.get("bytes") or 0) + (u.get("bytes") or 0)
        out.append({
            "id": d["id"], "subject_id": d["subject_id"], "topic_id": d["topic_id"], "kind": d["kind"], "filename": d["filename"],
            "status": d["status"], "error": d["error"], "path": str(path), "missing": not path.exists(),
            "size": {"file": file_size, "render": render_size, "assets": asset_size, "index": index,
                     "total": file_size + render_size + asset_size + index},
            "units": d["unit_count"], "text_chunks": c.get("text_chunks") or 0, "vision_chunks": c.get("vision_chunks") or 0,
            "unembedded": c.get("unembedded") or 0, "stale": bool(d["embed_model"]) and d["embed_model"] != model,
            "vision_total": d["vision_total"], "vision_done": d["vision_done"], "vision_failed": u.get("vision_failed") or 0,
            "flags": (flags.get(d["id"]) or {}).get("flags", 0), "reviewing": d["id"] in reviewing,
            "old_parser": d["status"] in ("ready", "vision") and d["parser_version"] != PARSER_VERSION,
            # why the viewer shows the simplified layout (render.py), only while no exact copy exists
            "render_error": d["render_error"] if d["ext"] in render.OFFICE_EXTS and not rendered.exists() else None,
        })

    db_size = sum(p.stat().st_size for p in config.DATA_DIR.glob("study.db*") if p.is_file())
    orphans = _orphans()
    return {
        "data_dir": str(config.DATA_DIR), "db_path": str(config.db_path()), "embed_model": model,
        "log_path": str(config.DATA_DIR / "logs" / "backend.log"),
        "disk": {"database": db_size, "files": _tree_size(config.files_dir()), "renders": _tree_size(render.renders_dir()),
                 "assets": _tree_size(config.assets_dir())},
        "orphans": {k: {"count": len(v), "bytes": sum(_tree_size(p) for p in v)} for k, v in orphans.items()},
        "stale_rows": sum(len(v) for v in _stale_rows().values()),
        "parser_version": PARSER_VERSION,
        "subjects": db.q("SELECT id, name, color FROM subjects ORDER BY position IS NULL, position, name COLLATE NOCASE"),
        "topics": db.q("SELECT id, subject_id, name FROM topics ORDER BY position IS NULL, position, name COLLATE NOCASE"),
        "documents": out,
    }


class CleanupBody(BaseModel):
    compact: bool = False  # also VACUUM the database (returns the space deleted rows leave behind)


@router.post("/maintenance/cleanup")
def cleanup(body: CleanupBody):
    import shutil
    freed = 0
    for paths in _orphans().values():
        for p in paths:
            size = _tree_size(p)
            try:
                shutil.rmtree(p) if p.is_dir() else p.unlink()
                freed += size
            except OSError:
                pass
    rows = _stale_rows()
    with db.tx() as c:
        c.executemany("DELETE FROM figure_cache WHERE key=?", [(k,) for k in rows["figure_cache"]])
        c.executemany("DELETE FROM snapshots WHERE path=?", [(p,) for p in rows["snapshots"]])
        c.executemany("DELETE FROM practice_exams WHERE id=?", [(i,) for i in rows["practice_exams"]])
    if body.compact:
        before = sum(p.stat().st_size for p in config.DATA_DIR.glob("study.db*") if p.is_file())
        db.ex("VACUUM")
        db.ex("PRAGMA wal_checkpoint(TRUNCATE)")
        freed += max(0, before - sum(p.stat().st_size for p in config.DATA_DIR.glob("study.db*") if p.is_file()))
    return {"freed": freed}


@router.post("/maintenance/reparse")
def reparse(body: ScopeBody):
    """Read files again that an older parser read (they may be missing text a newer one finds, e.g. SmartArt). Their
    finished vision notes are kept for every page whose content is unchanged, and unchanged chunks keep their vectors
    only through re-embedding (parsing again rebuilds them)."""
    queued = 0
    for did in _scope_docs(body):
        d = db.q1("SELECT status, parser_version FROM documents WHERE id=?", (did,))
        if d and d["status"] in ("ready", "vision") and d["parser_version"] != PARSER_VERSION:
            db.ex("UPDATE documents SET status='queued', updated_at=? WHERE id=?", (time.time(), did))
            jobs.enqueue("ingest", did, ref_id=pipeline.KEEP_VISION)
            queued += 1
    return {"queued": queued}


@router.post("/maintenance/reembed")
def reembed(body: ScopeBody):
    """Embed the chunks without a vector from the current model (and index vision notes not indexed yet). Cheaper
    than re-ingesting after an embedding model change: nothing is parsed again."""
    model = llm.embed_model()
    queued = 0
    for did in _scope_docs(body):
        if db.q1("""SELECT 1 FROM documents d WHERE d.id=? AND d.status IN ('ready','vision') AND (d.vision_indexed=0 OR EXISTS
                    (SELECT 1 FROM chunks c WHERE c.document_id=d.id AND (c.embedding IS NULL OR c.embed_model IS NOT ?)))""", (did, model)):
            jobs.enqueue("embed", did)
            queued += 1
    return {"queued": queued}


class ScanBody(ScopeBody):
    review: bool = True  # also queue the model review (one vision-lane job per document)
    recheck: bool = False  # review units the model already reviewed


@router.post("/maintenance/vision-scan")
def vision_scan(body: ScanBody):
    ids = _scope_docs(body)
    flagged = vision_audit.rule_scan(ids)
    queued, units = 0, 0
    if body.review:
        for did in ids:
            n = len(vision_audit.review_candidates(did, body.recheck))
            if n:
                jobs.enqueue("audit", did, ref_id=jobs.RECHECK if body.recheck else None)
                queued, units = queued + 1, units + n
    return {"rule_flags": flagged, "queued": queued, "units": units}


@router.get("/maintenance/vision-flags")
def vision_flags(subject_id: int | None = None, topic_id: int | None = None, document_id: int | None = None,
                 dismissed: bool = False):
    ids = _scope_docs(ScopeBody(subject_id=subject_id, topic_id=topic_id, document_id=document_id))
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    return db.q(f"""SELECT f.id, f.document_id, f.kind, f.reason, f.source, f.created_at, f.dismissed, u.idx unit, u.label,
                           SUBSTR(COALESCE(u.vision_notes, ''), 1, 1200) notes, LENGTH(COALESCE(u.vision_notes, '')) notes_length,
                           u.vision_status, d.filename, d.subject_id, d.topic_id, t.name topic
                    FROM vision_flags f JOIN units u ON u.id=f.unit_id JOIN documents d ON d.id=f.document_id
                    LEFT JOIN topics t ON t.id=d.topic_id
                    WHERE f.document_id IN ({marks}) AND f.dismissed=?
                    ORDER BY d.filename COLLATE NOCASE, u.idx, f.source DESC""", (*ids, int(dismissed)))


class FlagIds(BaseModel):
    ids: list[int]
    restore: bool = False


@router.post("/maintenance/vision-flags/dismiss")
def dismiss_flags(body: FlagIds):
    if not body.ids:
        return {"ok": True}
    marks = ",".join("?" * len(body.ids))
    rows = db.q(f"SELECT f.document_id, f.kind, f.source, u.idx FROM vision_flags f JOIN units u ON u.id=f.unit_id WHERE f.id IN ({marks})", body.ids)
    db.ex(f"UPDATE vision_flags SET dismissed=? WHERE id IN ({marks})", (int(not body.restore), *body.ids))
    # A malformed rule flag keeps the unit's notes out of search; dismissing (or restoring) it changes that.
    by_doc: dict[int, list[int]] = {}
    for r in rows:
        if r["source"] == "rule" and r["kind"] == "malformed":
            by_doc.setdefault(r["document_id"], []).append(r["idx"])
    for did, idxs in by_doc.items():
        pipeline.index_vision(did, idxs)
    return {"ok": True}


class RerunBody(ScopeBody):
    flag_ids: list[int] | None = None  # these flags' units; otherwise every unit with an open flag in the scope


@router.post("/maintenance/vision-rerun")
def vision_rerun(body: RerunBody):
    """Re-run vision on flagged units only. Their flags go; the new notes are checked by the rules again."""
    if body.flag_ids is not None:
        if not body.flag_ids:
            return {"units": 0, "queued": 0}
        rows = db.q(f"SELECT DISTINCT unit_id, document_id FROM vision_flags WHERE id IN ({','.join('?' * len(body.flag_ids))})",
                    body.flag_ids)
    else:
        ids = _scope_docs(body)
        if not ids:
            return {"units": 0, "queued": 0}
        rows = db.q(f"SELECT DISTINCT unit_id, document_id FROM vision_flags WHERE dismissed=0 AND document_id IN "
                    f"({','.join('?' * len(ids))})", ids)
    if not rows:
        raise HTTPException(400, "Nothing flagged to re-run")
    with db.tx() as c:
        for r in rows:
            c.execute("UPDATE units SET vision_status='pending', vision_audited=0 WHERE id=? AND needs_vision=1", (r["unit_id"],))
            c.execute("DELETE FROM vision_flags WHERE unit_id=? AND dismissed=0", (r["unit_id"],))
    docs = sorted({r["document_id"] for r in rows})
    for did in docs:
        db.ex("UPDATE documents SET updated_at=? WHERE id=?", (time.time(), did))
        jobs.enqueue("vision", did)
    return {"units": len(rows), "queued": len(docs)}


# ---------------------------------------------------------------- database backups (db.backup)

@router.get("/backups")
def backups():
    return {"backups": db.list_backups(), "pending_restore": db.pending_restore(), "folder": str(config.backups_dir()),
            "keep": db.KEEP}


@router.post("/backups")
def backup_now():
    return db.backup("manual")


class RestoreBody(BaseModel):
    name: str | None = None  # None cancels a pending restore


@router.post("/backups/restore")
def restore_backup(body: RestoreBody):
    """Takes effect at the next start: the current data is backed up, then replaced by this copy."""
    try:
        db.request_restore(body.name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"pending_restore": db.pending_restore()}


@router.delete("/backups/{name}")
def delete_backup(name: str):
    if not db.delete_backup(name):
        raise HTTPException(404, "No such backup")
    return {"ok": True}
