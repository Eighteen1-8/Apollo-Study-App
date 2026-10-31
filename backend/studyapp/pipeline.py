"""Ingest pipeline: parse -> exact dedupe -> select vision units -> chunk -> embed; then (separate lane) vision notes."""
import json
import re
import shutil
import time

import numpy as np

from . import config, db, dedupe, llm, render
from .chunker import chunk_units
from .parsers import PARSER_VERSION, approx_tokens, parse, render_for_vision, render_pdf_page


class Cancelled(Exception):
    pass


KEEP_VISION = 1  # ingest job ref_id: re-ingest after a move, keeping this file's finished vision notes


def doc_path(doc):
    return config.files_dir() / f"{doc['sha256']}{doc['ext']}"


def scope_doc_ids(doc) -> list[int]:
    """Documents a unit may duplicate: same topic (topic material) or the subject's reference library."""
    if doc["kind"] == "reference":
        rows = db.q("SELECT id FROM documents WHERE subject_id=? AND kind='reference' AND id<=?", (doc["subject_id"], doc["id"]))
    else:
        rows = db.q("SELECT id FROM documents WHERE topic_id=? AND kind='topic' AND id<=?", (doc["topic_id"], doc["id"]))
    return [r["id"] for r in rows]


def _selected_for_vision(u, mode, ext):
    if mode == "off":
        return False
    if mode == "all":
        return ext in (".pdf", ".pptx") or bool(u["images"])
    return bool(u["reasons"])


def unit_images(doc, u) -> list[bytes]:
    """Images of a unit for vision and previews. Slides come from the exact PDF copy when there is one (fonts,
    backgrounds, SmartArt and shapes included), else from the approximate composite."""
    if doc["ext"] == ".pptx":
        pdf = render.rendered_pdf(doc, convert=False)
        if pdf:
            return [render_pdf_page(pdf, u["idx"])]
    return render_for_vision(doc_path(doc), u, config.assets_dir())


def clear_document(doc_id):
    with db.tx() as c:
        c.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=?)", (doc_id,))
        c.execute("DELETE FROM chunks WHERE document_id=?", (doc_id,))
        c.execute("DELETE FROM units WHERE document_id=?", (doc_id,))
    shutil.rmtree(config.assets_dir() / str(doc_id), ignore_errors=True)


def annotation_blocks(doc_id, positions: dict[int, list[float]] | None = None) -> dict[int, str]:
    """The student's highlights, notes and text boxes per unit, as text appended to that unit's material.
    Annotations made on a Word file's exact PDF copy (data.space == 'pdf') sit on a page; `positions` maps them back
    to the section they fall in."""
    lines: dict[int, list[str]] = {}
    for a in db.q("SELECT unit, kind, anchor, data FROM annotations WHERE document_id=? AND kind IN "
                  "('highlight','note','textbox') ORDER BY unit, id", (doc_id,)):
        anchor, data = json.loads(a["anchor"]), json.loads(a["data"])
        unit = a["unit"]
        if data.get("space") == "pdf" and positions is not None:
            y = anchor["rects"][0][1] if anchor.get("rects") else data.get("y", 0)
            unit = render.unit_at(positions, a["unit"], y)
            if unit is None:
                continue
        quoted = " ".join((anchor.get("text") or "").split())
        text = (data.get("text") or "").strip()
        if a["kind"] == "highlight" and quoted:
            line = f'- Highlighted: "{quoted}"'
        elif a["kind"] == "note" and text:
            line = (f'- Definition of "{quoted}": {text}' if data.get("definition") and quoted
                    else f'- Note on "{quoted}": {text}' if quoted else f"- Note: {text}")
        elif a["kind"] == "textbox" and text:
            line = f"- Written on the page: {text}"
        else:
            continue
        lines.setdefault(unit, []).append(line)
    return {u: "[Student's annotations]\n" + "\n".join(ls) for u, ls in lines.items()}


def _set_doc(doc_id, **kw):
    kw["updated_at"] = time.time()
    db.ex(f"UPDATE documents SET {', '.join(f'{k}=?' for k in kw)} WHERE id=?", (*kw.values(), doc_id))


def ingest(doc_id, job, keep_vision=False):
    """Returns the number of units still waiting for vision."""
    doc = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    s = db.get_settings()
    # Same file, same unit index, same exact content: the vision input is unchanged, so its notes still hold.
    kept_vision = {(r["idx"], r["content_hash"]): r for r in db.q(
        "SELECT idx, content_hash, vision_notes, vision_relevant FROM units WHERE document_id=? AND vision_status='done'",
        (doc_id,))} if keep_vision else {}
    clear_document(doc_id)
    _set_doc(doc_id, status="parsing", error=None, render_map=None)
    job.update(0.02, "Parsing")
    units, meta = parse(doc_path(doc), config.assets_dir() / str(doc_id), s)
    job.check()
    positions = None
    if doc["ext"] in render.OFFICE_EXTS:
        job.update(0.05, "Making an exact copy for the viewer")
        render.rendered_pdf(doc)  # cached by file hash; no-op without Office/LibreOffice
        positions = render.unit_positions(doc, units)
        job.check()
    annotated_at = doc["annotated_at"]
    student_notes = annotation_blocks(doc_id, positions)

    # Exact dedupe + vision selection, unit by unit (so within-document repeats are caught too).
    scope = scope_doc_ids(doc)
    dupes, vision_total, vision_done, kept = 0, 0, 0, []
    with db.tx() as c:
        for u in units:
            # The hash is of the file's own content; the student's notes are added after it, and an annotated unit
            # is never dropped as a duplicate (that would drop the notes too).
            chash = dedupe.content_hash(u["text"], u["image_hashes"])
            notes = student_notes.get(u["idx"])
            original = None
            if s["dedupe_units"] and not notes and dedupe.is_dedupable(u["text"], u["image_hashes"]):
                original = dedupe.find_original(c, scope, chash)
            if notes:
                u["text"] = f"{u['text']}\n\n{notes}".strip()
            vision = original is None and _selected_for_vision(u, doc["vision_mode"], doc["ext"])
            prev = kept_vision.get((u["idx"], chash)) if vision else None
            vision_total += vision
            vision_done += prev is not None
            dupes += original is not None
            u["id"] = c.execute(
                "INSERT INTO units(document_id, idx, kind, label, text, content_hash, duplicate_of, token_count, equations,"
                " images, needs_vision, vision_reasons, vision_status, vision_notes, vision_relevant)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (doc_id, u["idx"], u["kind"], u["label"], u["text"], chash, original, approx_tokens(u["text"]),
                 u["equations"], json.dumps(u["images"]), int(vision), json.dumps(u["reasons"]),
                 "done" if prev else "pending" if vision else "none",
                 prev["vision_notes"] if prev else None, prev["vision_relevant"] if prev else None)).lastrowid
            if original is None:
                kept.append(u)

    chunks = chunk_units(kept, int(s["chunk_target_tokens"]), int(s["chunk_max_slides"]))
    with db.tx() as c:
        for ch in chunks:
            ch["id"] = c.execute(
                "INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,?,?,?,?,?)",
                (doc_id, ch["unit_start"], ch["unit_end"], ch["label"], ch["text"], ch["token_count"])).lastrowid
            c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (ch["id"], ch["text"]))
    _set_doc(doc_id, status="embedding", unit_count=len(units), duplicate_units=dupes,
             token_count=sum(approx_tokens(u["text"]) for u in kept), chunk_count=len(chunks),
             stripped_lines=meta.get("stripped_lines", 0), vision_total=vision_total, vision_done=vision_done,
             parser_version=PARSER_VERSION)

    # Embed only the real extracted text.
    model, batch = llm.embed_model(), int(s["embed_batch"])
    for i in range(0, len(chunks), batch):
        job.check()
        part = chunks[i:i + batch]
        vecs = llm.embed([c["text"] for c in part])
        with db.tx() as c:
            for ch, v in zip(part, vecs):
                c.execute("UPDATE chunks SET embedding=?, embed_model=? WHERE id=?", (v.astype(np.float32).tobytes(), model, ch["id"]))
        job.update(0.1 + 0.9 * min(i + batch, len(chunks)) / max(len(chunks), 1),
                   f"Embedding {min(i + batch, len(chunks))}/{len(chunks)} chunks")
    pending = vision_total - vision_done
    _set_doc(doc_id, embed_model=model, status="vision" if pending else "ready", annotations_ingested=annotated_at)
    return pending


VISION_SYSTEM = """You transcribe the visual content of study material so a student (and Apollo, their tutor) can learn from it without seeing the image.
Rules:
- Cover every educational visual: figures, diagrams, graphs, charts, tables, circuits, labelled drawings, photos of apparatus, equations shown as images.
- Graphs: axes and units, shape/trend, key values, intercepts, what the graph demonstrates.
- Circuits/diagrams: every component, value and label, how parts connect, what it illustrates.
- Transcribe any text that appears inside images. Write equations in LaTeX between $...$.
- Do NOT repeat the extracted text you are given unless needed to explain a visual. Never invent details you cannot see.
- If the visuals are purely decorative (logos, stock photos, backgrounds, icons) with no learning content, reply with exactly: IRRELEVANT"""


def run_vision(doc_id, job):
    doc = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    reasoning = db.setting("vision_reasoning")
    path = doc_path(doc)
    pending = db.q("SELECT * FROM units WHERE document_id=? AND vision_status IN ('pending','failed') ORDER BY idx", (doc_id,))
    total = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND needs_vision=1", (doc_id,))["n"]
    _set_doc(doc_id, status="vision", vision_total=total)
    for k, u in enumerate(pending):
        job.check()
        u["images"] = json.loads(u["images"])
        job.update(k / max(len(pending), 1), f"Vision: {u['label']} ({k + 1}/{len(pending)})")
        try:
            images = unit_images(doc, u)
            asset = None
            if doc["ext"] in (".pdf", ".pptx"):
                asset = f"{doc_id}/vision_{u['idx']}.png"
                (config.assets_dir() / str(doc_id)).mkdir(parents=True, exist_ok=True)
                (config.assets_dir() / asset).write_bytes(images[0])
            content = [{"type": "text", "text": f"Source: {doc['filename']}, {u['label']}\n\nExtracted text:\n{u['text'] or '(none)'}"}]
            content += [llm.image_part(img, "image/png" if img[:4] == b"\x89PNG" else "image/jpeg") for img in images]
            res = llm.chat([{"role": "system", "content": VISION_SYSTEM}, {"role": "user", "content": content}],
                           max_tokens=8000, reasoning=reasoning, temperature=0.2)
            notes = re.sub(r"<think>.*?</think>", "", res["content"], flags=re.S).strip()
            relevant = notes.upper().strip(" .") != "IRRELEVANT"
            if res["finish"] == "length":
                notes += "\n\n[truncated: output limit reached]"
            db.ex("UPDATE units SET vision_status='done', vision_notes=?, vision_relevant=?, vision_image=? WHERE id=?",
                  (notes if relevant else None, int(relevant), asset, u["id"]))
        except Cancelled:
            raise
        except Exception as e:
            db.ex("UPDATE units SET vision_status='failed', vision_notes=? WHERE id=?", (f"[vision error] {e}", u["id"]))
        done = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND vision_status='done'", (doc_id,))["n"]
        _set_doc(doc_id, vision_done=done)
    failed = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND vision_status='failed'", (doc_id,))["n"]
    _set_doc(doc_id, status="ready", error=f"{failed} unit(s) failed vision" if failed else None)
