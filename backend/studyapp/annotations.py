"""The student's annotations on a document (highlights, note boxes, pen strokes, text boxes), "Define this", and
exporting an annotated PDF. Text-bearing annotations are folded into the material on the next ingest
(pipeline.annotation_blocks), so changing them flags the document for re-ingest."""
import json
import re
import time
from pathlib import Path
from urllib.parse import quote

import pymupdf
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from . import context, db, jobs, llm, pipeline, render, search

router = APIRouter()

KINDS = ("highlight", "note", "ink", "textbox", "region")  # region: a screenshot area sent to the chat
TEXT_KINDS = ("highlight", "note", "textbox")  # what ingest folds into the material; ink is drawing only


def _out(a):
    a = dict(a)
    a["anchor"] = json.loads(a["anchor"])
    a["data"] = json.loads(a["data"])
    return a


def _doc(did):
    d = db.q1("SELECT * FROM documents WHERE id=?", (did,))
    if d is None:
        raise HTTPException(404, "Document not found")
    return d


def _touch(did, kind):
    if kind in TEXT_KINDS:
        db.ex("UPDATE documents SET annotated_at=? WHERE id=?", (time.time(), did))


def status(did) -> dict:
    d = _doc(did)
    has = db.q1(f"SELECT 1 FROM annotations WHERE document_id=? AND kind IN ({','.join('?' * len(TEXT_KINDS))})",
                (did, *TEXT_KINDS)) is not None
    changed = d["annotated_at"] is not None and d["annotated_at"] != d["annotations_ingested"]
    # Deleting every note also counts as a change if the last ingest included some.
    return {"needs_reingest": changed and (has or d["annotations_ingested"] is not None), "doc_status": d["status"]}


@router.get("/documents/{did}/annotations")
def list_annotations(did: int):
    items = [_out(a) for a in db.q("SELECT * FROM annotations WHERE document_id=? ORDER BY unit, id", (did,))]
    return {"items": items, **status(did)}


class AnnoBody(BaseModel):
    unit: int
    kind: str
    anchor: dict = {}
    data: dict = {}


@router.post("/documents/{did}/annotations")
def create_annotation(did: int, body: AnnoBody):
    _doc(did)
    if body.kind not in KINDS:
        raise HTTPException(400, "Unknown annotation kind")
    now = time.time()
    aid = db.ex("INSERT INTO annotations(document_id, unit, kind, anchor, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (did, body.unit, body.kind, json.dumps(body.anchor), json.dumps(body.data), now, now))
    _touch(did, body.kind)
    return _out(db.q1("SELECT * FROM annotations WHERE id=?", (aid,)))


class AnnoPatch(BaseModel):
    unit: int | None = None
    anchor: dict | None = None
    data: dict | None = None  # merged into the stored data


@router.patch("/annotations/{aid}")
def patch_annotation(aid: int, body: AnnoPatch):
    a = db.q1("SELECT * FROM annotations WHERE id=?", (aid,))
    if a is None:
        raise HTTPException(404)
    data = {**json.loads(a["data"]), **(body.data or {})}
    anchor = body.anchor if body.anchor is not None else json.loads(a["anchor"])
    db.ex("UPDATE annotations SET unit=?, anchor=?, data=?, updated_at=? WHERE id=?",
          (body.unit if body.unit is not None else a["unit"], json.dumps(anchor), json.dumps(data), time.time(), aid))
    # Only text changes alter what Qwen would read; moving or hiding a note doesn't.
    if body.anchor is not None or (body.data and {"text", "title"} & body.data.keys()):
        _touch(a["document_id"], a["kind"])
    return _out(db.q1("SELECT * FROM annotations WHERE id=?", (aid,)))


@router.delete("/annotations/{aid}")
def delete_annotation(aid: int):
    a = db.q1("SELECT * FROM annotations WHERE id=?", (aid,))
    if a:
        db.ex("DELETE FROM annotations WHERE id=?", (aid,))
        _touch(a["document_id"], a["kind"])
    return {"ok": True}


@router.post("/documents/{did}/reingest-annotations")
def reingest_with_annotations(did: int):
    """Re-read the file with the student's notes folded in. Vision notes for unchanged pages are kept."""
    _doc(did)
    jobs.cancel_for_document(did)
    db.ex("UPDATE documents SET status='queued', updated_at=? WHERE id=?", (time.time(), did))
    return {"job_id": jobs.enqueue("ingest", did, ref_id=pipeline.KEEP_VISION)}


# ---------------------------------------------------------------- Define this

class DefineBody(BaseModel):
    text: str
    before: str = ""
    after: str = ""
    label: str = ""


DEFINE_SYSTEM = """You are Apollo, writing short glossary definitions for a student. Define the term or phrase as it is used in
the passage, in 1-3 plain sentences a student can learn from. If the material provided defines it, follow that
definition. Use LaTeX between $...$ for any maths. Reply with the definition only: no heading, no preamble."""


@router.post("/documents/{did}/define")
def define(did: int, body: DefineBody):
    d = _doc(did)
    term = body.text.strip()
    if not term:
        raise HTTPException(400, "Nothing selected")
    refs = [r["id"] for r in db.q("SELECT id FROM documents WHERE subject_id=? AND unit_count > 0 AND (id=? OR kind='reference')",
                                  (d["subject_id"], did))]
    try:
        material = context._format_hits(search.search(term, refs, k=4))
    except Exception:  # embeddings offline: define from the passage alone
        material = ""
    prompt = (f"Term: {term}\n\nPassage ({d['filename']}{' · ' + body.label if body.label else ''}):\n"
              f"…{body.before} {term} {body.after}…" + (f"\n\nRelated material:\n{material}" if material else ""))
    res = llm.chat([{"role": "system", "content": DEFINE_SYSTEM}, {"role": "user", "content": prompt}],
                   max_tokens=600, reasoning="off", temperature=0.2)
    return {"definition": re.sub(r"<think>.*?</think>", "", res["content"], flags=re.S).strip()}


# ---------------------------------------------------------------- export

def _rgb(hexcolor: str, fallback=(1, 0.85, 0.2)):
    try:
        h = hexcolor.lstrip("#")
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except Exception:
        return fallback


class ExportBody(BaseModel):
    path: str  # where to save, chosen by the student in a save dialog


@router.post("/documents/{did}/export")
def export_pdf_to(did: int, body: ExportBody):
    res = export_pdf(did)
    out = Path(body.path)
    if out.suffix.lower() != ".pdf":
        out = out.with_suffix(".pdf")
    try:
        out.write_bytes(res.body)
    except OSError as e:
        raise HTTPException(400, f"Couldn't save there: {e}")
    return {"path": str(out)}


@router.get("/documents/{did}/export")
def export_pdf(did: int):
    """The original PDF with the student's annotations written in as real PDF annotations."""
    d = _doc(did)
    pdf_path = render.viewer_pdf(d, convert=False)
    if not pdf_path:
        raise HTTPException(400, "Exporting is available for PDFs, and for slides and Word files once their exact copy exists")
    pdf = pymupdf.open(pdf_path)
    for a in map(_out, db.q("SELECT * FROM annotations WHERE document_id=? ORDER BY id", (did,))):
        if not 1 <= a["unit"] <= len(pdf):
            continue
        page = pdf[a["unit"] - 1]
        W, H = page.rect.width, page.rect.height
        data, anchor = a["data"], a["anchor"]

        def box(x, y, w, h):
            return pymupdf.Rect(x * W, y * H, (x + w) * W, (y + h) * H)

        def ink(strokes, ox=0.0, oy=0.0, sw=1.0, sh=1.0):
            # strokes are fractions of the page (or of the note box, mapped through ox/oy/sw/sh)
            for s in strokes:
                pts = s["points"]
                line = [((ox + pts[i] * sw) * W, (oy + pts[i + 1] * sh) * H) for i in range(0, len(pts) - 1, 2)]
                if len(line) > 1:
                    an = page.add_ink_annot([line])
                    an.set_colors(stroke=_rgb(s.get("color", "#e5484d")))
                    an.set_border(width=max(s.get("width", 0.003) * W, 0.5))
                    an.update()

        if a["kind"] == "note" and data.get("area") and anchor.get("rects"):
            rr = page.add_rect_annot(box(*anchor["rects"][0]))
            rr.set_colors(stroke=_rgb("#e0a800"))
            rr.set_info(content=data.get("text", ""))
            rr.update()
        elif a["kind"] in ("highlight", "note") and anchor.get("rects"):
            hl = page.add_highlight_annot([box(*r) for r in anchor["rects"]])
            hl.set_colors(stroke=_rgb(data.get("color", "#ffd84d")))
            if a["kind"] == "note":
                hl.set_info(content=(data.get("title", "") + "\n" + data.get("text", "")).strip())
            hl.update()
        if a["kind"] == "region":
            rr = page.add_rect_annot(box(data.get("x", 0), data.get("y", 0), data.get("w", 0), data.get("h", 0)))
            rr.set_colors(stroke=_rgb(data.get("color", "#7c8cff")))
            rr.update()
        if a["kind"] == "ink":
            ink(data.get("strokes", []))
        elif a["kind"] == "textbox" and data.get("text", "").strip():
            r = box(data.get("x", 0), data.get("y", 0), data.get("w", 0.3), data.get("h", 0.05))
            fs = max(data.get("size", 0.018) * W, 6)
            r.y1 = max(r.y1, r.y0 + fs * 1.4 * (data["text"].count("\n") + 1))
            ft = page.add_freetext_annot(r, data["text"], fontsize=fs, text_color=_rgb(data.get("color", "#e5484d")))
            ft.update()
        elif a["kind"] == "note" and not data.get("hidden"):
            r = box(data.get("x", 0), data.get("y", 0), data.get("w", 0.3), data.get("h", 0.15))
            text = (data.get("title", "") + "\n" + data.get("text", "")).strip()
            if text:
                ft = page.add_freetext_annot(r, text, fontsize=9, text_color=(0.1, 0.1, 0.1), fill_color=(1, 0.95, 0.6))
                ft.update()
            if data.get("strokes"):
                ink(data["strokes"], data.get("x", 0), data.get("y", 0), data.get("w", 0.3), data.get("h", 0.15))
    name = re.sub(r"\.[^.]+$", "", d["filename"]) + " (annotated).pdf"
    return Response(pdf.tobytes(), media_type="application/pdf",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})

