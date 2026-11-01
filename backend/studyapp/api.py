"""HTTP API used by the Electron renderer (localhost only)."""
import hashlib
import io
import json
import re
import shutil
import time
from pathlib import Path

import pymupdf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from PIL import Image
from pydantic import BaseModel

from . import config, db, jobs, llm, pipeline, render, search, viewer
from .annotations import router as annotations_router
from .chat_api import router as chat_router
from .projection import router as projection_router
from .study_api import router as study_router
from .parsers import IMAGE_EXTS, SUPPORTED, TEXT_EXTS

app = FastAPI(title="StudyApp backend")
app.include_router(chat_router)
app.include_router(annotations_router)
app.include_router(study_router)
app.include_router(projection_router)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"^(http://(localhost|127\.0\.0\.1)(:\d+)?|file://.*|null)$",
                   allow_methods=["*"], allow_headers=["*"])

SECRET_KEYS = ("llm_api_key", "embed_api_key", "openrouter_api_key")


def _404(row, what="Not found"):
    if row is None:
        raise HTTPException(404, what)
    return row


# ---------------------------------------------------------------- health & settings

@app.get("/health")
def health():
    return {"ok": True, "data_dir": str(config.DATA_DIR)}


@app.get("/settings")
def get_settings():
    s = db.get_settings()
    for k in SECRET_KEYS:  # never send keys back to the UI, only whether one is set
        s[k] = "••••••••" if s.get(k) else ""
    return s


@app.put("/settings")
def put_settings(values: dict):
    values = {k: v for k, v in values.items() if not (k in SECRET_KEYS and v == "••••••••")}
    db.put_settings(values)
    return get_settings()


@app.post("/settings/test")
def test_settings():
    return llm.test_connections()


# ---------------------------------------------------------------- subjects & topics

class NameBody(BaseModel):
    name: str
    color: str | None = None
    description: str | None = None


@app.get("/subjects")
def list_subjects():
    subjects = db.q("SELECT * FROM subjects ORDER BY name COLLATE NOCASE")
    model = llm.embed_model()
    # stale: embedded with a different model than the current one, so search can't use them until re-ingested
    topics = db.q("""SELECT t.*, (SELECT COUNT(*) FROM documents d WHERE d.topic_id=t.id) AS doc_count,
                     (SELECT COUNT(*) FROM documents d WHERE d.topic_id=t.id AND d.embed_model IS NOT NULL AND d.embed_model<>?) AS stale_docs
                     FROM topics t ORDER BY t.name COLLATE NOCASE""", (model,))
    refs = {r["subject_id"]: r["n"] for r in db.q("SELECT subject_id, COUNT(*) n FROM documents WHERE kind='reference' GROUP BY subject_id")}
    stale = {r["subject_id"]: r["n"] for r in db.q(
        "SELECT subject_id, COUNT(*) n FROM documents WHERE embed_model IS NOT NULL AND embed_model<>? GROUP BY subject_id", (model,))}
    stale_refs = {r["subject_id"]: r["n"] for r in db.q(
        "SELECT subject_id, COUNT(*) n FROM documents WHERE kind='reference' AND embed_model IS NOT NULL AND embed_model<>? GROUP BY subject_id", (model,))}
    for s in subjects:
        s["topics"] = [t for t in topics if t["subject_id"] == s["id"]]
        s["reference_count"] = refs.get(s["id"], 0)
        s["stale_docs"] = stale.get(s["id"], 0)
        s["stale_reference_docs"] = stale_refs.get(s["id"], 0)
    return subjects


@app.get("/embedding-status")
def embedding_status(model: str | None = None):
    """How many files would need re-ingesting with embedding model `model` (for the settings warning): those embedded
    with any other model. Switching back to the model files were embedded with needs nothing."""
    model = model or llm.embed_model()
    return {"documents": db.q1("SELECT COUNT(*) n FROM documents WHERE embed_model IS NOT NULL AND embed_model<>?", (model,))["n"],
            "current": llm.embed_model()}


class StaleBody(BaseModel):
    topic_id: int | None = None
    reference: bool = False  # only the reference library


@app.post("/subjects/{sid}/reingest-stale")
def reingest_stale(sid: int, body: StaleBody):
    """Re-ingest the files embedded with another model (a whole subject, one topic, or its reference library)."""
    where, args = "subject_id=?", [sid]
    if body.topic_id is not None:
        where, args = "topic_id=?", [body.topic_id]
    elif body.reference:
        where += " AND kind='reference'"
    rows = db.q(f"SELECT id FROM documents WHERE {where} AND embed_model IS NOT NULL AND embed_model<>?", (*args, llm.embed_model()))
    for r in rows:
        jobs.cancel_for_document(r["id"])
        db.ex("UPDATE documents SET status='queued', updated_at=? WHERE id=?", (time.time(), r["id"]))
        jobs.enqueue("ingest", r["id"], ref_id=pipeline.KEEP_VISION)
    return {"queued": len(rows)}


@app.post("/subjects")
def create_subject(body: NameBody):
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    sid = db.ex("INSERT INTO subjects(name, color, created_at) VALUES (?,?,?)", (body.name.strip(), body.color or "#7c8cff", time.time()))
    return db.q1("SELECT * FROM subjects WHERE id=?", (sid,))


@app.patch("/subjects/{sid}")
def update_subject(sid: int, body: NameBody):
    _404(db.q1("SELECT id FROM subjects WHERE id=?", (sid,)))
    db.ex("UPDATE subjects SET name=?, color=COALESCE(?, color) WHERE id=?", (body.name.strip(), body.color, sid))
    return db.q1("SELECT * FROM subjects WHERE id=?", (sid,))


@app.delete("/subjects/{sid}")
def delete_subject(sid: int):
    for d in db.q("SELECT id FROM documents WHERE subject_id=?", (sid,)):
        delete_document(d["id"])
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))
    return {"ok": True}


@app.post("/subjects/{sid}/topics")
def create_topic(sid: int, body: NameBody):
    _404(db.q1("SELECT id FROM subjects WHERE id=?", (sid,)), "Subject not found")
    if not body.name.strip():
        raise HTTPException(400, "Name required")
    tid = db.ex("INSERT INTO topics(subject_id, name, description, created_at) VALUES (?,?,?,?)",
                (sid, body.name.strip(), body.description or "", time.time()))
    return db.q1("SELECT * FROM topics WHERE id=?", (tid,))


@app.get("/topics/{tid}")
def get_topic(tid: int):
    t = _404(db.q1("SELECT t.*, s.name AS subject_name, s.color AS subject_color FROM topics t JOIN subjects s ON s.id=t.subject_id WHERE t.id=?", (tid,)))
    t["stats"] = db.q1("""SELECT COUNT(*) docs, COALESCE(SUM(token_count),0) tokens, COALESCE(SUM(chunk_count),0) chunks,
                          COALESCE(SUM(vision_done),0) vision_done, COALESCE(SUM(vision_total),0) vision_total
                          FROM documents WHERE topic_id=?""", (tid,))
    t["context_budget"] = int(llm.context_tokens() * 0.65)
    return t


@app.patch("/topics/{tid}")
def update_topic(tid: int, body: NameBody):
    _404(db.q1("SELECT id FROM topics WHERE id=?", (tid,)))
    db.ex("UPDATE topics SET name=?, description=COALESCE(?, description) WHERE id=?", (body.name.strip(), body.description, tid))
    return db.q1("SELECT * FROM topics WHERE id=?", (tid,))


@app.delete("/topics/{tid}")
def delete_topic(tid: int):
    for d in db.q("SELECT id FROM documents WHERE topic_id=?", (tid,)):
        delete_document(d["id"])
    db.ex("DELETE FROM topics WHERE id=?", (tid,))
    return {"ok": True}


# ---------------------------------------------------------------- documents

class UploadBody(BaseModel):
    paths: list[str]
    topic_id: int | None = None
    subject_id: int | None = None  # reference library upload when topic_id is None
    vision_mode: str | None = None  # off | auto | all


@app.post("/documents")
def upload_documents(body: UploadBody):
    if body.topic_id is not None:
        t = _404(db.q1("SELECT * FROM topics WHERE id=?", (body.topic_id,)), "Topic not found")
        subject_id, kind = t["subject_id"], "topic"
        scope_sql, scope_arg = "topic_id=? AND kind='topic'", body.topic_id
    elif body.subject_id is not None:
        _404(db.q1("SELECT id FROM subjects WHERE id=?", (body.subject_id,)), "Subject not found")
        subject_id, kind = body.subject_id, "reference"
        scope_sql, scope_arg = "subject_id=? AND kind='reference'", body.subject_id
    else:
        raise HTTPException(400, "topic_id or subject_id required")
    mode = body.vision_mode or db.setting("vision_default_reference" if kind == "reference" else "vision_default_topic")
    if mode not in ("off", "auto", "all"):
        raise HTTPException(400, "vision_mode must be off, auto or all")

    results = []
    for p in body.paths:
        path = Path(p)
        ext = path.suffix.lower()
        if not path.is_file():
            results.append({"filename": path.name, "status": "error", "message": "File not found"})
            continue
        if ext not in SUPPORTED:
            results.append({"filename": path.name, "status": "error", "message": f"Unsupported type {ext}"})
            continue
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(1 << 20), b""):
                h.update(block)
        digest = h.hexdigest()
        # File-level exact dedupe within the same scope.
        dup = db.q1(f"SELECT id, filename FROM documents WHERE {scope_sql} AND sha256=?", (scope_arg, digest))
        if dup:
            results.append({"filename": path.name, "status": "duplicate", "message": f"Identical to {dup['filename']}"})
            continue
        stored = config.files_dir() / f"{digest}{ext}"
        if not stored.exists():
            shutil.copyfile(path, stored)
        now = time.time()
        did = db.ex("""INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (subject_id, body.topic_id, kind, path.name, ext, digest, stored.stat().st_size, "queued", mode, now, now))
        jobs.enqueue("ingest", did)
        results.append({"filename": path.name, "status": "queued", "document_id": did})
    return results


@app.get("/topics/{tid}/documents")
def topic_documents(tid: int):
    return db.q("SELECT * FROM documents WHERE topic_id=? ORDER BY created_at", (tid,))


@app.get("/subjects/{sid}/documents")
def reference_documents(sid: int):
    return db.q("SELECT * FROM documents WHERE subject_id=? AND kind='reference' ORDER BY created_at", (sid,))


@app.get("/documents/{did}")
def get_document(did: int):
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    units = db.q("SELECT * FROM units WHERE document_id=? ORDER BY idx", (did,))
    dup_src = {}
    for u in units:
        u["images"] = json.loads(u["images"])
        u["vision_reasons"] = json.loads(u["vision_reasons"])
        if u["duplicate_of"]:
            dup_src[u["duplicate_of"]] = None
    if dup_src:
        marks = ",".join("?" * len(dup_src))
        for r in db.q(f"SELECT u.id, u.label, d.filename FROM units u JOIN documents d ON d.id=u.document_id WHERE u.id IN ({marks})", tuple(dup_src)):
            dup_src[r["id"]] = f"{r['filename']} · {r['label']}"
        for u in units:
            if u["duplicate_of"]:
                u["duplicate_label"] = dup_src.get(u["duplicate_of"])
    d["units"] = units
    d["chunks"] = db.q("SELECT id, unit_start, unit_end, label, token_count, embed_model IS NOT NULL AS embedded FROM chunks WHERE document_id=? ORDER BY id", (did,))
    return d


@app.delete("/documents/{did}")
def delete_document(did: int):
    d = db.q1("SELECT * FROM documents WHERE id=?", (did,))
    if d is None:
        return {"ok": True}
    jobs.cancel_for_document(did)
    pipeline.clear_document(did)
    db.ex("DELETE FROM documents WHERE id=?", (did,))
    if not db.q1("SELECT id FROM documents WHERE sha256=?", (d["sha256"],)):
        (config.files_dir() / f"{d['sha256']}{d['ext']}").unlink(missing_ok=True)
    return {"ok": True}


@app.post("/documents/{did}/reingest")
def reingest(did: int):
    _404(db.q1("SELECT id FROM documents WHERE id=?", (did,)))
    jobs.cancel_for_document(did)
    db.ex("UPDATE documents SET status='queued', updated_at=? WHERE id=?", (time.time(), did))
    return {"job_id": jobs.enqueue("ingest", did)}


class MoveBody(BaseModel):
    topic_id: int | None = None  # None = the subject's reference library


@app.post("/documents/{did}/move")
def move_document(did: int, body: MoveBody):
    """Move a file between topics and the reference library (same subject). Dedupe is scoped per topic / per reference
    library, so every document whose exact-duplicate links change is re-ingested; finished vision notes are kept."""
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    if body.topic_id is not None:
        t = _404(db.q1("SELECT * FROM topics WHERE id=?", (body.topic_id,)), "Topic not found")
        if t["subject_id"] != d["subject_id"]:
            raise HTTPException(400, "Files can only move within their subject")
        kind, scope_sql, scope_arg = "topic", "topic_id=? AND kind='topic'", body.topic_id
    else:
        kind, scope_sql, scope_arg = "reference", "subject_id=? AND kind='reference'", d["subject_id"]
    if d["kind"] == kind and d["topic_id"] == body.topic_id:
        return d
    dup = db.q1(f"SELECT filename FROM documents WHERE {scope_sql} AND sha256=? AND id<>?", (scope_arg, d["sha256"], did))
    if dup:
        raise HTTPException(409, f"An identical file is already there ({dup['filename']})")
    # Units elsewhere in the old scope that were exact duplicates of this file now need their own text again.
    old_dependents = [r["document_id"] for r in db.q(
        """SELECT DISTINCT u.document_id FROM units u JOIN units o ON o.id=u.duplicate_of
           WHERE o.document_id=? AND u.document_id<>?""", (did, did))]
    db.ex("UPDATE documents SET kind=?, topic_id=?, updated_at=? WHERE id=?", (kind, body.topic_id, time.time(), did))
    # Later files in the new scope sharing exact content become duplicates of this (earlier) one.
    later = [r["document_id"] for r in db.q(
        f"""SELECT DISTINCT document_id FROM units WHERE document_id IN (SELECT id FROM documents WHERE {scope_sql} AND id>?)
            AND content_hash IN (SELECT content_hash FROM units WHERE document_id=?)""", (scope_arg, did, did))]
    for doc_id in dict.fromkeys([did, *old_dependents, *later]):
        jobs.cancel_for_document(doc_id)
        db.ex("UPDATE documents SET status='queued', updated_at=? WHERE id=?", (time.time(), doc_id))
        jobs.enqueue("ingest", doc_id, ref_id=pipeline.KEEP_VISION)
    return db.q1("SELECT * FROM documents WHERE id=?", (did,))


MEDIA = {".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8"}


@app.get("/documents/{did}/file")
def document_file(did: int):
    """The original file, for the in-app viewer (pdf.js, images, text)."""
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    path = pipeline.doc_path(d)
    if not path.is_file():
        raise HTTPException(404, "Stored file missing")
    media = MEDIA.get(d["ext"]) or ("text/plain; charset=utf-8" if d["ext"] in TEXT_EXTS else None)
    return FileResponse(path, media_type=media)


@app.get("/documents/{did}/layout")
def document_layout(did: int):
    """How the viewer shows a file. PDFs, and Office files once Office/LibreOffice has made an exact PDF copy (on the
    first view if ingest didn't), go to pdf.js; without a converter, slides and Word fall back to an HTML layout."""
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    path = pipeline.doc_path(d)
    if d["ext"] in render.OFFICE_EXTS and render.rendered_pdf(d):
        return {"kind": "pdf", "source": d["ext"][1:], "url": f"/documents/{did}/view.pdf",
                "unit_pos": render.unit_positions(d)}
    if d["ext"] == ".pptx":
        return viewer.pptx_layout(path, did)
    if d["ext"] == ".docx":
        return viewer.docx_layout(path, did)
    if d["ext"] in IMAGE_EXTS:
        return {"kind": "image"}
    if d["ext"] == ".pdf":
        return {"kind": "pdf", "source": "pdf", "url": f"/documents/{did}/file"}
    return {"kind": "text"}


@app.get("/documents/{did}/view.pdf")
def document_view_pdf(did: int):
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    pdf = render.viewer_pdf(d, convert=False)
    if not pdf:
        raise HTTPException(404, "No PDF copy of this file")
    return FileResponse(pdf, media_type="application/pdf")


@app.get("/documents/{did}/thumb/{page}")
def page_thumb(did: int, page: int, w: int = 120):
    """Small page images for the viewer's minimap."""
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    pdf_path = render.viewer_pdf(d, convert=False)
    if not pdf_path:
        raise HTTPException(404)
    w = max(40, min(w, 240))
    cache = config.assets_dir() / str(did) / f"thumb_{page}_{w}.png"
    if not cache.exists():
        pdf = pymupdf.open(pdf_path)
        if not 1 <= page <= len(pdf):
            raise HTTPException(404)
        p = pdf[page - 1]
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_bytes(p.get_pixmap(matrix=pymupdf.Matrix(w / p.rect.width, w / p.rect.width)).tobytes("png"))
    return FileResponse(cache, headers={"Cache-Control": "max-age=86400"})


@app.get("/documents/{did}/outline")
def document_outline(did: int):
    """Chapters for the viewer: the PDF's bookmarks (Word headings become bookmarks in the exact copy), else slide
    titles or section headings. Each entry: {level, title, unit, y} where unit is the page/slide/section."""
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    pdf_path = render.viewer_pdf(d, convert=False)
    out = []
    if pdf_path:
        pdf = pymupdf.open(pdf_path)
        for lvl, title, page, dest in pdf.get_toc(simple=False):
            if not 1 <= page <= len(pdf) or not title.strip():
                continue
            to = dest.get("to") if isinstance(dest, dict) else None
            pg = pdf[page - 1]
            # bookmark targets are in PDF space (origin bottom-left); map to the page as displayed (top-left)
            y = (pymupdf.Point(to) * pg.transformation_matrix).y / pg.rect.height if to is not None else 0.0
            out.append({"level": lvl, "title": re.sub(r"^Slide \d+:\s*", "", title.strip()), "unit": page,
                        "y": round(min(max(y, 0.0), 1.0), 4)})
    if out:
        return out
    units = db.q("SELECT idx, label FROM units WHERE document_id=? ORDER BY idx", (did,))
    if d["ext"] == ".pptx":
        return [{"level": 1, "title": u["label"].split(" · ", 1)[1], "unit": u["idx"], "y": 0} for u in units if " · " in u["label"]]
    if d["ext"] == ".docx":
        pos = render.unit_positions(d) if pdf_path else {}
        return [{"level": 1, "title": u["label"], "unit": pos[u["idx"]][0] if pdf_path else u["idx"],
                 "y": pos[u["idx"]][1] if pdf_path else 0} for u in units
                if (not pdf_path or u["idx"] in pos) and not u["label"].startswith("Paragraphs ")]
    if d["ext"] in TEXT_EXTS:
        return [{"level": 1, "title": u["label"], "unit": u["idx"], "y": 0} for u in units]
    return []


class SnapBody(BaseModel):
    unit: int
    rect: list[float]  # x, y, w, h as fractions of the page


@app.post("/documents/{did}/snapshot")
def snapshot(did: int, body: SnapBody):
    """A sharp image of part of a page (right-drag in the viewer), saved for sending to the chat."""
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    x, y, w, h = (max(0.0, min(1.0, v)) for v in body.rect)
    pdf_path = render.viewer_pdf(d, convert=False)
    if pdf_path:
        page = pymupdf.open(pdf_path)[body.unit - 1]
        W, H = page.rect.width, page.rect.height
        clip = pymupdf.Rect(x * W, y * H, (x + w) * W, (y + h) * H)
        zoom = min(200 / 72, 2400 / max(clip.width, clip.height, 1))  # ~200 dpi, at most 2400 px
        png = page.get_pixmap(clip=clip, matrix=pymupdf.Matrix(zoom, zoom)).tobytes("png")
    elif d["ext"] in IMAGE_EXTS:
        im = Image.open(pipeline.doc_path(d))
        box = (int(x * im.width), int(y * im.height), int((x + w) * im.width), int((y + h) * im.height))
        buf = io.BytesIO()
        im.crop(box).convert("RGB").save(buf, "PNG")
        png = buf.getvalue()
    else:
        raise HTTPException(400, "Screenshots work on PDFs, slides, Word files and images")
    stem = re.sub(r'[<>:"/\\|?*]+', " ", re.sub(r"\.[^.]+$", "", d["filename"])).strip()[:60]
    name = f"{stem} p{body.unit} selection {hashlib.sha256(png).hexdigest()[:6]}.png"
    rel = f"chat/{name}"
    out = config.assets_dir() / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)
    db.ex("INSERT OR REPLACE INTO snapshots(path, document_id, unit, rect, created_at) VALUES (?,?,?,?,?)",
          (str(out.resolve()), did, body.unit, json.dumps([x, y, w, h]), time.time()))
    return {"path": str(out.resolve()), "asset": rel, "name": name}


class VisionBody(BaseModel):
    mode: str | None = None  # change vision mode: re-selects units (keeps finished notes)
    retry_failed: bool = True


@app.post("/documents/{did}/vision")
def run_vision(did: int, body: VisionBody):
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    if body.mode:
        if body.mode not in ("off", "auto", "all"):
            raise HTTPException(400, "bad mode")
        db.ex("UPDATE documents SET vision_mode=? WHERE id=?", (body.mode, did))
        for u in db.q("SELECT id, images, vision_reasons, vision_status FROM units WHERE document_id=? AND duplicate_of IS NULL", (did,)):
            sel = pipeline._selected_for_vision({"images": json.loads(u["images"]), "reasons": json.loads(u["vision_reasons"])}, body.mode, d["ext"])
            if sel and u["vision_status"] in ("none", "skipped"):
                db.ex("UPDATE units SET needs_vision=1, vision_status='pending' WHERE id=?", (u["id"],))
            elif not sel and u["vision_status"] == "pending":
                db.ex("UPDATE units SET needs_vision=0, vision_status='none' WHERE id=?", (u["id"],))
    total = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND needs_vision=1", (did,))["n"]
    db.ex("UPDATE documents SET vision_total=? WHERE id=?", (total, did))
    if db.q1("SELECT 1 FROM units WHERE document_id=? AND vision_status IN ('pending','failed')", (did,)):
        return {"job_id": jobs.enqueue("vision", did)}
    return {"job_id": None}


@app.get("/documents/{did}/units/{idx}/preview")
def unit_preview(did: int, idx: int):
    d = _404(db.q1("SELECT * FROM documents WHERE id=?", (did,)))
    u = _404(db.q1("SELECT * FROM units WHERE document_id=? AND idx=?", (did, idx)))
    if u["vision_image"] and (config.assets_dir() / u["vision_image"]).exists():
        return FileResponse(config.assets_dir() / u["vision_image"])
    u["images"] = json.loads(u["images"])
    if d["ext"] in (".pdf", ".pptx"):
        cache = config.assets_dir() / str(did) / f"preview_{idx}.png"
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(pipeline.unit_images(d, u)[0])
        return FileResponse(cache)
    if u["images"]:
        return FileResponse(config.assets_dir() / u["images"][0])
    return Response(status_code=204)


@app.get("/assets/{rel:path}")
def asset(rel: str):
    root = config.assets_dir().resolve()
    p = (root / rel).resolve()
    if root not in p.parents or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p)


# ---------------------------------------------------------------- jobs & search

@app.get("/jobs")
def list_jobs(active: bool = False):
    where = ("WHERE j.status IN ('queued','running')" if active else
             "WHERE j.updated_at > ? AND (j.dismissed=0 OR j.status IN ('queued','running'))")
    args = () if active else (time.time() - 3600,)
    return db.q(f"""SELECT j.*, COALESCE(d.filename, a.title, aa.title || ' (marking)') AS filename FROM jobs j
                    LEFT JOIN documents d ON d.id=j.document_id
                    LEFT JOIN artifacts a ON j.type='generate' AND a.id=j.ref_id
                    LEFT JOIN attempts t ON j.type='mark' AND t.id=j.ref_id LEFT JOIN artifacts aa ON aa.id=t.artifact_id {where}
                    ORDER BY CASE j.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, j.id DESC LIMIT 100""", args)


@app.post("/jobs/{jid}/cancel")
def cancel_job(jid: int):
    jobs.cancel(jid)
    return {"ok": True}


@app.post("/jobs/dismiss")
def dismiss_jobs(job_id: int | None = None):
    """Hide a finished job (or every finished job) from the jobs list. Queued and running jobs can't be dismissed."""
    sql = "UPDATE jobs SET dismissed=1 WHERE status NOT IN ('queued','running')"
    db.ex(sql + (" AND id=?" if job_id else ""), (job_id,) if job_id else ())
    return {"ok": True}


class SearchBody(BaseModel):
    query: str
    topic_id: int | None = None
    subject_id: int | None = None
    include_reference: bool = True
    k: int = 10


@app.post("/search")
def do_search(body: SearchBody):
    ids = search.scope_documents(body.topic_id, body.subject_id, body.include_reference)
    try:
        return {"results": search.search(body.query, ids, body.k), "warning": None}
    except Exception as e:  # e.g. embedding server offline: fall back to keyword-only
        return {"results": [], "warning": f"Search failed: {e}"}
