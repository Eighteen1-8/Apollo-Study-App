"""Ingest pipeline: parse -> exact dedupe -> select vision units -> chunk -> embed; then (separate lane) vision notes,
which get chunks of their own (source='vision') so pages that are only images (scans, diagrams) can be found."""
import logging
import json
import re
import shutil
import time

import numpy as np

from . import config, db, dedupe, errors, llm, render, vision_audit
from .chunker import _split_long, chunk_units
from .parsers import PARSER_VERSION, approx_tokens, parse, render_for_vision, render_pdf_page

log = logging.getLogger(__name__)


class Cancelled(Exception):
    pass


class Yield(Exception):
    """A long job steps aside for others in its lane; it goes back in the queue and resumes where it stopped."""


KEEP_VISION = 1  # ingest job ref_id: re-ingest, keeping this file's finished vision notes
ANNOTATIONS_HEADER = "[Student's annotations]"  # starts the block annotation_blocks() appends to a unit's text


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
        c.execute("DELETE FROM vision_flags WHERE document_id=?", (doc_id,))
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
    return {u: f"{ANNOTATIONS_HEADER}\n" + "\n".join(ls) for u, ls in lines.items()}


def _set_doc(doc_id, **kw):
    kw["updated_at"] = time.time()
    db.ex(f"UPDATE documents SET {', '.join(f'{k}=?' for k in kw)} WHERE id=?", (*kw.values(), doc_id))


def ingest(doc_id, job, keep_vision=False):
    """Returns the number of units still waiting for vision. A document that was already parsed and chunked when the
    app stopped (status 'embedding', same parser) only finishes its embeddings: nothing is parsed again."""
    doc = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if doc is None:  # deleted while its job waited
        raise Cancelled()
    if (doc["status"] == "embedding" and doc["parser_version"] == PARSER_VERSION
            and db.q1("SELECT 1 FROM chunks WHERE document_id=? LIMIT 1", (doc_id,))):
        job.update(0.1, "Resuming: embedding")
        embed_chunks(doc_id, job, start=0.1)
        pending = max(0, (doc["vision_total"] or 0) - (doc["vision_done"] or 0))
        _set_doc(doc_id, status="vision" if pending else "ready", annotations_ingested=doc["annotated_at"])
        return pending
    s = db.get_settings()
    # Same file, same unit index, same exact content: the vision input is unchanged, so its notes still hold.
    kept_vision = {(r["idx"], r["content_hash"]): r for r in db.q(
        "SELECT idx, content_hash, vision_notes, vision_relevant FROM units WHERE document_id=? AND vision_status='done'",
        (doc_id,))} if keep_vision else {}
    clear_document(doc_id)
    _set_doc(doc_id, status="parsing", error=None, render_map=None)
    job.update(0.02, "Parsing")
    path = doc_path(doc)
    if not path.exists():
        raise errors.AppError("APO-FILE-301", f"stored copy missing: {path}")
    try:
        units, meta = parse(path, config.assets_dir() / str(doc_id), s)
    except Exception as e:  # the parser's own error, coded: a locked file is told apart from a damaged one
        locked = "password" in str(e).lower() or "encrypt" in str(e).lower()
        raise errors.AppError("APO-FILE-305" if locked else "APO-FILE-304", f"{doc['filename']}: {type(e).__name__}: {e}") from e
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

    # Vision notes kept from before are checked and indexed beside the text, then everything is embedded.
    if vision_done:
        vision_audit.rule_scan([doc_id])
    index_vision(doc_id, embed=False)
    embed_chunks(doc_id, job, start=0.1)
    pending = vision_total - vision_done
    _set_doc(doc_id, status="vision" if pending else "ready", annotations_ingested=annotated_at)
    return pending


def vision_chunks(units, target: int) -> list[dict]:
    """Chunks of units' vision notes (units: idx, label, vision_notes), long notes split like long text."""
    out = []
    for u in units:
        pieces = _split_long(u["vision_notes"].strip(), target)
        for k, piece in enumerate(pieces, 1):
            text = f"[{u['label']} · visual content]\n{piece}"
            out.append({"unit_start": u["idx"], "unit_end": u["idx"], "text": text, "token_count": approx_tokens(text),
                        "label": f"{u['label']} (visual{f', part {k}' if len(pieces) > 1 else ''})"})
    return out


def index_vision(doc_id, idxs: list[int] | None = None, embed=True):
    """(Re)build a document's vision chunks (all units, or units `idxs`): finished, relevant notes, split like long
    text. Dedupe is unaffected (it hashes the file's own content). Notes the audit's rules flagged as malformed are
    left out. With `embed`, a failed embedding leaves the vectors empty for the maintenance re-embed to fill."""
    where, args = "document_id=? AND source='vision'", [doc_id]
    unit_where, unit_args = "", []
    if idxs is not None:
        if not idxs:
            return
        marks = ",".join("?" * len(idxs))
        where += f" AND unit_start IN ({marks})"
        args += idxs
        unit_where, unit_args = f" AND u.idx IN ({marks})", list(idxs)
    units = db.q(f"""SELECT u.idx, u.label, u.vision_notes FROM units u WHERE u.document_id=? AND u.vision_status='done'
                     AND u.vision_relevant=1 AND u.vision_notes IS NOT NULL AND u.duplicate_of IS NULL{unit_where}
                     AND NOT EXISTS (SELECT 1 FROM vision_flags f WHERE f.unit_id=u.id AND f.source='rule'
                                     AND f.kind='malformed' AND f.dismissed=0) ORDER BY u.idx""", (doc_id, *unit_args))
    target = int(db.setting("chunk_target_tokens"))
    reuse = _vectors(db.q(f"SELECT text, embedding, embed_model FROM chunks WHERE {where}", args))
    with db.tx() as c:
        c.execute(f"DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE {where})", args)
        c.execute(f"DELETE FROM chunks WHERE {where}", args)
        for ch in vision_chunks(units, target):
            vec, vmodel = reuse.get(ch["text"], (None, None))
            cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count, source, embedding, "
                            "embed_model) VALUES (?,?,?,?,?,?,'vision',?,?)",
                            (doc_id, ch["unit_start"], ch["unit_end"], ch["label"], ch["text"], ch["token_count"], vec, vmodel)).lastrowid
            c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, ch["text"]))
        # vision_indexed only after a whole-document pass: a single page doesn't mean the others have chunks
        c.execute(f"UPDATE documents SET {'vision_indexed=1, ' if idxs is None else ''}"
                  "chunk_count=(SELECT COUNT(*) FROM chunks WHERE document_id=?) WHERE id=?", (doc_id, doc_id))
    if embed and units:
        if llm.paused("embed"):  # vision carries on; the vectors come once embedding is resumed
            from . import jobs
            jobs.enqueue("embed", doc_id)
            return
        try:
            embed_chunks(doc_id)
        except Exception:  # e.g. the embedding server is offline; the notes themselves are saved
            log.warning("vision chunks of document %s not embedded yet", doc_id, exc_info=True)


def _vectors(rows) -> dict[str, tuple]:
    """Stored vectors by exact chunk text: a rebuilt chunk with the same text keeps its vector (no re-embedding)."""
    return {r["text"]: (r["embedding"], r["embed_model"]) for r in rows if r["embedding"] is not None}


def _same_text_vector(c, text) -> tuple:
    """A vector from any chunk with exactly this text and the current model (e.g. the unit this one duplicated)."""
    row = c.execute("SELECT embedding, embed_model FROM chunks WHERE text=? AND embedding IS NOT NULL AND embed_model=? LIMIT 1",
                    (text, llm.embed_model())).fetchone()
    return (row[0], row[1]) if row else (None, None)


def relink(doc_ids: list[int], rebuild=()) -> list[int]:
    """Recompute exact-duplicate links after files changed scope (a move, an import) from the stored units: nothing is
    parsed. Runs in document order, the order ingest dedupes in. A document whose links changed gets its chunks rebuilt;
    every chunk whose text is unchanged keeps its vector, and a unit that stops being a duplicate takes the vision notes
    of the identical unit it duplicated (`rebuild`: documents whose chunks are rebuilt either way). Returns the documents
    left with chunks that still need embedding."""
    from . import jobs
    dedupe_on = db.setting("dedupe_units")
    target, max_slides = int(db.setting("chunk_target_tokens")), int(db.setting("chunk_max_slides"))
    need_embed = []
    for did in sorted(set(doc_ids)):
        doc = db.q1("SELECT * FROM documents WHERE id=?", (did,))
        if doc is None:
            continue
        scope = [i for i in scope_doc_ids(doc) if i != did]
        earlier = f"document_id IN ({','.join('?' * len(scope))}) OR " if scope else ""
        changed = False
        with db.tx() as c:
            for u in db.q("SELECT * FROM units WHERE document_id=? ORDER BY idx", (did,)):
                original = None
                if dedupe_on and ANNOTATIONS_HEADER not in u["text"] and (u["text"].strip() or json.loads(u["images"])):
                    # earlier documents in the scope, or earlier units of this one (what ingest would have seen)
                    row = c.execute(f"SELECT id FROM units WHERE content_hash=? AND duplicate_of IS NULL AND "
                                    f"({earlier}(document_id=? AND idx<?)) ORDER BY document_id, idx LIMIT 1",
                                    (u["content_hash"], *scope, did, u["idx"])).fetchone()
                    original = row[0] if row else None
                if original == u["duplicate_of"]:
                    continue
                changed = True
                if original is None and u["vision_status"] != "done":  # its own content now: identical content, identical notes
                    src = c.execute("SELECT vision_status, vision_notes, vision_relevant FROM units WHERE id=?",
                                    (u["duplicate_of"],)).fetchone()
                    if src and src[0] == "done":
                        c.execute("UPDATE units SET needs_vision=1, vision_status='done', vision_notes=?, vision_relevant=?, "
                                  "vision_audited=0 WHERE id=?", (src[1], src[2], u["id"]))
                    elif _selected_for_vision({"images": json.loads(u["images"]), "reasons": json.loads(u["vision_reasons"])},
                                              doc["vision_mode"], doc["ext"]):
                        c.execute("UPDATE units SET needs_vision=1, vision_status='pending' WHERE id=?", (u["id"],))
                c.execute("UPDATE units SET duplicate_of=? WHERE id=?", (original, u["id"]))
        if not changed and did not in rebuild:
            continue
        kept = db.q("SELECT idx, kind, label, text FROM units WHERE document_id=? AND duplicate_of IS NULL ORDER BY idx", (did,))
        reuse = _vectors(db.q("SELECT text, embedding, embed_model FROM chunks WHERE document_id=? AND source='text'", (did,)))
        with db.tx() as c:
            c.execute("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE document_id=? AND source='text')", (did,))
            c.execute("DELETE FROM chunks WHERE document_id=? AND source='text'", (did,))
            for ch in chunk_units(kept, target, max_slides):
                vec, vmodel = reuse.get(ch["text"]) or _same_text_vector(c, ch["text"])
                cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count, embedding, "
                                "embed_model) VALUES (?,?,?,?,?,?,?,?)", (did, ch["unit_start"], ch["unit_end"], ch["label"],
                                                                         ch["text"], ch["token_count"], vec, vmodel)).lastrowid
                c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, ch["text"]))
        index_vision(did, embed=False)
        st = db.q1("""SELECT SUM(duplicate_of IS NOT NULL) dupes, SUM(CASE WHEN duplicate_of IS NULL THEN token_count END) tokens,
                      SUM(needs_vision=1 AND duplicate_of IS NULL) vt, SUM(vision_status='done' AND needs_vision=1 AND duplicate_of IS NULL) vd
                      FROM units WHERE document_id=?""", (did,))
        _set_doc(did, duplicate_units=st["dupes"] or 0, token_count=st["tokens"] or 0,
                 vision_total=st["vt"] or 0, vision_done=st["vd"] or 0)
        vision_audit.rule_scan([did])
        if (st["vt"] or 0) > (st["vd"] or 0):
            jobs.enqueue("vision", did)
        if db.q1("SELECT 1 FROM chunks WHERE document_id=? AND (embedding IS NULL OR embed_model IS NOT ?) LIMIT 1",
                 (did, llm.embed_model())):
            need_embed.append(did)
    return need_embed


def embed_chunks(doc_id, job=None, start=0.0) -> int:
    """Embed the document's chunks that have no vector from the current model: new chunks, or all of them after
    the embedding model changed (the stored chunk text is all that's needed, no re-parse)."""
    model, batch = llm.embed_model(), int(db.setting("embed_batch"))
    rows = db.q("SELECT id, text FROM chunks WHERE document_id=? AND (embedding IS NULL OR embed_model IS NOT ?) ORDER BY id",
                (doc_id, model))
    for i in range(0, len(rows), batch):
        if job:
            job.check()
        part = rows[i:i + batch]
        vecs = llm.embed([r["text"] for r in part])
        with db.tx() as c:
            for r, v in zip(part, vecs):
                c.execute("UPDATE chunks SET embedding=?, embed_model=? WHERE id=?", (v.astype(np.float32).tobytes(), model, r["id"]))
        if job:
            done = min(i + batch, len(rows))
            job.update(start + (1 - start) * done / len(rows), f"Embedding {done}/{len(rows)} chunks")
    _set_doc(doc_id, embed_model=model)
    return len(rows)


def reembed(doc_id, job):
    """Maintenance: index vision notes that have no chunks yet (databases from before vision chunks), then embed
    whatever lacks a current vector."""
    doc = db.q1("SELECT vision_indexed FROM documents WHERE id=?", (doc_id,))
    if doc is None:
        return
    if not doc["vision_indexed"]:
        job.update(0.02, "Indexing vision notes")
        index_vision(doc_id, embed=False)
    embed_chunks(doc_id, job, start=0.05)


VISION_SYSTEM = """You transcribe the visual content of study material so a student (and Apollo, their tutor) can learn from it without seeing the image.
Rules:
- Cover every educational visual: figures, diagrams, graphs, charts, tables, circuits, labelled drawings, photos of apparatus, equations shown as images.
- Graphs: axes and units, shape/trend, key values, intercepts, what the graph demonstrates.
- Circuits/diagrams: every component, value and label, how parts connect, what it illustrates.
- Transcribe any text that appears inside images. Write equations in LaTeX between $...$.
- Do NOT repeat the extracted text you are given unless needed to explain a visual. Never invent details you cannot see.
- If the visuals are purely decorative (logos, stock photos, backgrounds, icons) with no learning content, reply with exactly: IRRELEVANT"""


TRUNCATED = "[truncated: output limit reached]"


def clean_vision_output(text: str) -> str:
    """The description without the model's reasoning: closed <think> blocks, a reply whose opening tag was in the
    chat template (only </think> appears), and an unclosed block where the reply ran out mid-thought."""
    return llm.strip_think(text)


# Failures that every page would hit: the model can't be reached, the key is refused, the model is gone, the allowance
# is used up. The job stops with that reason and the pages stay pending, instead of each being marked failed in turn.
VISION_STOP = ("APO-LLM-101", "APO-LLM-103", "APO-LLM-104", "APO-LLM-105")


def run_vision(doc_id, job):
    doc = db.q1("SELECT * FROM documents WHERE id=?", (doc_id,))
    if doc is None:  # deleted while its job waited
        raise Cancelled()
    reasoning = db.setting("vision_reasoning")
    path = doc_path(doc)
    pending = db.q("SELECT * FROM units WHERE document_id=? AND vision_status IN ('pending','failed') ORDER BY idx", (doc_id,))
    total = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND needs_vision=1", (doc_id,))["n"]
    _set_doc(doc_id, status="vision", vision_total=total)
    for k, u in enumerate(pending):
        job.check()
        if k and job.should_yield():  # pages already described are saved; the rest wait for the next turn
            raise Yield()
        u["images"] = json.loads(u["images"])
        job.update(k / max(len(pending), 1), f"Vision: {u['label']} ({k + 1}/{len(pending)})")
        try:
            images = unit_images(doc, u)
            asset = None
            if doc["ext"] in (".pdf", ".pptx"):
                asset = f"{doc_id}/vision_{u['idx']}.png"
                (config.assets_dir() / str(doc_id)).mkdir(parents=True, exist_ok=True)
                config.write_atomic(config.assets_dir() / asset, images[0])
            content = [{"type": "text", "text": f"Source: {doc['filename']}, {u['label']}\n\nExtracted text:\n{u['text'] or '(none)'}"}]
            content += [llm.image_part(img, "image/png" if img[:4] == b"\x89PNG" else "image/jpeg") for img in images]
            msgs = [{"role": "system", "content": VISION_SYSTEM}, {"role": "user", "content": content}]
            res = llm.chat(msgs, max_tokens=8000, reasoning=reasoning, temperature=0.2)
            notes = clean_vision_output(res["content"])
            if (res["finish"] == "length" or not notes) and reasoning != "off":
                # Usually the reasoning used up the output budget: one more try without it.
                job.update(k / max(len(pending), 1), f"Vision: {u['label']} (retrying without reasoning)")
                res = llm.chat(msgs, max_tokens=8000, reasoning="off", temperature=0.2)
                notes = clean_vision_output(res["content"])
            if not notes:
                raise RuntimeError("the model returned no description")
            relevant = notes.upper().strip(" .") != "IRRELEVANT"
            if res["finish"] == "length":
                notes += "\n\n" + TRUNCATED
            with db.tx() as c:
                c.execute("UPDATE units SET vision_status='done', vision_notes=?, vision_relevant=?, vision_image=?, "
                          "vision_audited=0 WHERE id=?", (notes if relevant else None, int(relevant), asset, u["id"]))
                c.execute("DELETE FROM vision_flags WHERE unit_id=? AND dismissed=0", (u["id"],))
            vision_audit.rule_scan([doc_id], [u["id"]])
        except Cancelled:
            raise
        except Exception as e:
            err = errors.classify(e, "llm")
            if err.code in VISION_STOP:
                raise err
            log.warning("%s vision failed for %s, %s: %s", err.code, doc["filename"], u["label"], err.technical or err.plain)
            db.ex("UPDATE units SET vision_status='failed', vision_notes=?, vision_audited=0 WHERE id=?", (f"[vision error] {e}", u["id"]))
        index_vision(doc_id, [u["idx"]])
        done = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND vision_status='done'", (doc_id,))["n"]
        _set_doc(doc_id, vision_done=done)
    failed = db.q1("SELECT COUNT(*) n FROM units WHERE document_id=? AND vision_status='failed'", (doc_id,))["n"]
    _set_doc(doc_id, status="ready", error=f"{failed} unit(s) failed vision" if failed else None)
