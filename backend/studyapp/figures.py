"""Figures from the student's own material, for notes and chat replies.

Apollo never needs to see an image to choose one: the vision notes in its material describe every figure, so it
writes a tag where a figure belongs:

    [[figure: ElectricalCircuits.pdf · Page 13 | voltage divider circuit with R1 and R2]]

This module turns a tag into a cropped image:
  1. resolve the file and unit to a page of the viewer PDF (the PDF itself, or the exact copy of slides/Word);
  2. find the figures on that page from the PDF's structure: embedded image boxes and clusters of vector drawing,
     each grown to take in the labels around it;
  3. if there is more than one, show the page with numbered boxes to the vision model and ask which number matches
     the description (choosing a number is far more reliable than asking a model for coordinates);
     with none, ask it for the figure's box; failing that, use the whole page or slide;
  4. crop at ~170 dpi, save under assets/figures/, cache by (file, page, description)."""
import hashlib
import io
import json
import re

import pymupdf
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel

from . import config, db, llm, render

FIGURE_TAG = re.compile(r"\[\[\s*figure:\s*([^\]|]+?\.[A-Za-z0-9]{2,5})\s*[·|\-–]\s*([^\]|]+?)\s*\|\s*([^\]]+?)\s*\]\]", re.I)
_norm = lambda s: re.sub(r"[^a-z0-9]+", " ", re.sub(r"\.(pdf|pptx|docx|txt|md|png|jpe?g)$", "", s.lower())).strip()  # noqa: E731


def _doc_for(subject_id: int, file: str):
    docs = db.q("SELECT * FROM documents WHERE subject_id=? AND unit_count > 0", (subject_id,))
    f = _norm(file)
    return next((d for d in docs if _norm(d["filename"]) == f), None) or next(
        (d for d in docs if _norm(d["filename"]).startswith(f) or f.startswith(_norm(d["filename"]))), None)


def _unit_for(doc, label: str):
    units = db.q("SELECT idx, label, images FROM units WHERE document_id=? ORDER BY idx", (doc["id"],))
    l = label.lower().strip()
    m = re.match(r"^(slide|page|part)\s+(\d+)", l)
    if m:
        return next((u for u in units if u["idx"] == int(m.group(2))), None)
    return (next((u for u in units if u["label"].lower() == l), None)
            or next((u for u in units if u["label"].lower().startswith(l) or l.startswith(u["label"].lower())), None)
            or next((u for u in units if l in u["label"].lower()), None))


# ---------------------------------------------------------------- finding figures on a page

def _merge(rects: list, gap: float) -> list:
    """Union rectangles that touch or sit within `gap` of each other, until stable."""
    boxes = [pymupdf.Rect(r) for r in rects]
    changed = True
    while changed:
        changed = False
        out = []
        while boxes:
            b = boxes.pop()
            grown = pymupdf.Rect(b.x0 - gap, b.y0 - gap, b.x1 + gap, b.y1 + gap)
            i = 0
            while i < len(boxes):
                if grown.intersects(boxes[i]):
                    b |= boxes.pop(i)
                    grown = pymupdf.Rect(b.x0 - gap, b.y0 - gap, b.x1 + gap, b.y1 + gap)
                    changed = True
                else:
                    i += 1
            out.append(b)
        boxes = out
    return boxes


def candidates(page) -> list:
    """Likely figures on a page, largest first."""
    W, H = page.rect.width, page.rect.height
    area = W * H
    found = []
    for info in page.get_images(full=True):
        for r in page.get_image_rects(info[0]):
            r = r & page.rect
            if 0.012 < (r.width * r.height) / area < 0.9:  # skip icons and full-page backgrounds
                found.append(r)
    text_boxes = [pymupdf.Rect(b[:4]) for b in page.get_text("blocks") if b[4].strip()]
    strokes = []
    for d in page.get_drawings():
        r = d["rect"]
        if r.width * r.height <= 2 or r.width > 0.85 * W or r.height > 0.85 * H or (r.height < 1.5 and r.width > 0.6 * W):
            continue  # full-width bands, page frames and long rules aren't figures
        items = d.get("items") or []
        if d.get("fill") is not None and len(items) == 1 and items[0][0] == "re" and any(r.contains(t) for t in text_boxes):
            continue  # a filled box behind text: a text box's background (title bars, callouts)
        strokes.append(r)
    for c in _merge(strokes, gap=6):
        if (c.width * c.height) / area > 0.02 and c.width > 40 and c.height > 30:
            found.append(c)
    boxes = _merge(found, gap=3)
    # take in labels: short text blocks overlapping a figure's edge (axis numbers, captions inside the figure)
    blocks = [pymupdf.Rect(b[:4]) for b in page.get_text("blocks") if len(b[4].strip()) < 80]
    out = []
    for b in boxes:
        for t in blocks:
            if t.intersects(b) and t.width * t.height < 0.5 * b.width * b.height:
                b |= t
        # A column of body text that only grazes the figure's side (e.g. over a picture's white margin) is cut off.
        # Only sideways, and only when the overlap is a sliver of that text, so labels and axes are never lost.
        for t in text_boxes:
            ov = t & b
            if ov.is_empty or ov.width * ov.height >= 0.25 * t.width * t.height or ov.width > 0.15 * b.width:
                continue
            if t.x0 < b.x0 <= t.x1 < b.x1:
                b.x0 = t.x1
            elif b.x0 < t.x0 <= b.x1 < t.x1:
                b.x1 = t.x0
        m = 0.015 * max(W, H)
        out.append(pymupdf.Rect(b.x0 - m, b.y0 - m, b.x1 + m, b.y1 + m) & page.rect)
    out = [b for b in out if (b.width * b.height) / area < 0.92]
    return sorted(out, key=lambda r: -(r.width * r.height))[:8]


def _page_png(page, dpi=110, boxes=None) -> bytes:
    pix = page.get_pixmap(dpi=dpi)
    im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    if boxes:
        k = dpi / 72
        draw = ImageDraw.Draw(im)
        try:
            font = ImageFont.truetype("arialbd.ttf", 28)
        except OSError:
            font = ImageFont.load_default()
        for n, b in enumerate(boxes, 1):
            draw.rectangle([b.x0 * k, b.y0 * k, b.x1 * k, b.y1 * k], outline=(230, 20, 20), width=4)
            draw.rectangle([b.x0 * k, b.y0 * k, b.x0 * k + 34, b.y0 * k + 34], fill=(230, 20, 20))
            draw.text((b.x0 * k + 8, b.y0 * k + 1), str(n), fill="white", font=font)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


class _Box(BaseModel):
    box: list[float]


def _choose(page, boxes, hint: str):
    """The box showing `hint`: picked by number from the candidates, else located by the vision model."""
    if len(boxes) == 1:
        return boxes[0]
    if boxes:
        res = llm.chat([{"role": "user", "content": [
            {"type": "text", "text": f"The numbered red boxes mark the figures on this page. Which box contains: {hint}?\n"
                                     "Reply with only the box number, or 0 if none of them shows it."},
            llm.image_part(_page_png(page, boxes=boxes))]}], max_tokens=16, reasoning="off", temperature=0)
        m = re.search(r"\d+", re.sub(r"<think>.*?</think>", "", res["content"], flags=re.S))
        if m and 1 <= int(m.group()) <= len(boxes):
            return boxes[int(m.group()) - 1]
    try:
        b = llm.chat_json([{"role": "user", "content": [
            {"type": "text", "text": f"Find the figure/diagram/graph on this page that shows: {hint}. Give its bounding box "
                                     "including its labels as fractions of the page width and height: "
                                     '{"box": [x0, y0, x1, y1]} with 0 <= x0 < x1 <= 1 and 0 <= y0 < y1 <= 1.'},
            llm.image_part(_page_png(page))]}], _Box, reasoning="off").box
        x0, y0, x1, y1 = (max(0.0, min(1.0, v)) for v in b[:4])
        if x1 - x0 > 0.08 and y1 - y0 > 0.05:
            W, H = page.rect.width, page.rect.height
            return pymupdf.Rect(x0 * W, y0 * H, x1 * W, y1 * H)
    except Exception:
        pass
    return None


# ---------------------------------------------------------------- tags → images

def _save(png: bytes) -> str:
    rel = f"figures/{hashlib.sha256(png).hexdigest()[:24]}.png"
    out = config.assets_dir() / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)
    return rel


def figure(subject_id: int, file: str, label: str, hint: str) -> dict | None:
    """{asset, file, label, doc_id, unit, whole} for one tag, or None when the source can't be found."""
    doc = _doc_for(subject_id, file)
    unit = doc and _unit_for(doc, label)
    if not unit:
        return None
    key = hashlib.sha256(f"{doc['sha256']}|{unit['idx']}|{hint.strip().lower()}".encode()).hexdigest()
    hit = db.q1("SELECT data FROM figure_cache WHERE key=?", (key,))
    if hit and (config.assets_dir() / json.loads(hit["data"])["asset"]).exists():
        return json.loads(hit["data"])
    out = {"file": doc["filename"], "label": unit["label"], "doc_id": doc["id"], "unit": unit["idx"], "whole": False}
    pdf_path = render.viewer_pdf(doc, convert=False)
    if pdf_path:
        page_no = unit["idx"]
        if doc["ext"] == ".docx":
            page_no = render.unit_positions(doc).get(unit["idx"], [1, 0])[0]
        pdf = pymupdf.open(pdf_path)
        if not 1 <= page_no <= len(pdf):
            return None
        page = pdf[page_no - 1]
        box = _choose(page, candidates(page), hint)
        if box is None:
            box, out["whole"] = page.rect, True
        zoom = min(170 / 72, 1600 / max(box.width, box.height, 1))
        out["asset"] = _save(page.get_pixmap(clip=box, matrix=pymupdf.Matrix(zoom, zoom)).tobytes("png"))
        out["page"] = page_no
    else:
        from .pipeline import unit_images  # slides without an exact copy, images, Word pictures
        images = unit_images(doc, {**unit, "images": json.loads(unit["images"])})
        if not images:
            return None
        out["asset"], out["whole"] = _save(images[0]), True
    db.ex("INSERT OR REPLACE INTO figure_cache(key, data) VALUES (?, ?)", (key, json.dumps(out)))
    return out


def resolve(subject_id: int, text: str, limit: int = 4, on_progress=None) -> dict[str, dict]:
    """Images for the figure tags in `text` (first `limit` distinct ones), keyed by the exact tag text."""
    out = {}
    for m in FIGURE_TAG.finditer(text):
        tag = m.group(0)
        if tag in out or len(out) >= limit:
            continue
        file, label, hint = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        if on_progress:
            on_progress(f"Finding the figure on {label.split(' · ')[0]}")
        try:
            fig = figure(subject_id, file, label, hint)
        except Exception as e:  # a missing figure must never break notes or a reply
            print(f"[figures] {tag}: {e}")
            fig = None
        out[tag] = {**fig, "caption": hint} if fig else {"missing": True, "caption": hint, "file": file, "label": label}
    return out
