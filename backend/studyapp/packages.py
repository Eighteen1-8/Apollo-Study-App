"""Settings → Share: export embedded files as one zip ("study pack") and import packs made on another computer, so a
class can share the expensive part (parsing, vision notes, embeddings) instead of everyone redoing it.

A pack (FORMAT, VERSION) holds:
    manifest.json             subject, topics, and one entry per document (keys d1, d2, ... and t1, t2, ...)
    files/<sha256><ext>       the original files
    renders/<sha256>.pdf      exact PDF copies of Office files, when there are any
    assets/<doc key>/<name>   images extracted from the files and the page images vision saw
    data/<doc key>.json       units (text, dedupe hash, vision notes), chunks, annotations, render map
    data/<doc key>.npy        the chunks' vectors (float32, one row per chunk that has one; chunk "vec" is the row)

Exact-duplicate links only point inside the pack: a unit duplicating a file that isn't exported carries its own text and
chunks instead. The student's annotations (highlights, notes, drawings) go in only if asked; they are never part of the
unit text. Packs from older versions may have them folded into unit text: importing cuts that out (_strip_notes) and
rebuilds those documents' chunks. Importing never parses or runs vision:
units, chunks and vectors are copied, dedupe links are recomputed against what is already there (pipeline.relink),
and only vectors from a different embedding model are made again. Packs come from other people, so nothing in one is
trusted: member names are never used as paths, files are checked against their hashes, and vectors load without pickle."""
import hashlib
import io
import json
import os
import re
import tempfile
import time
import zipfile
from pathlib import Path

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import config, db, grants, jobs, llm, pipeline, render, vision_audit
from .chunker import chunk_units
from .parsers import SUPPORTED, approx_tokens

router = APIRouter()

FORMAT, VERSION = "apollo-study-pack", 1
MAX_UNPACKED = 8 << 30  # refuse packs claiming more than 8 GB once unpacked
_SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
_DOC_COLS = ("filename", "ext", "sha256", "size", "kind", "vision_mode", "parser_version", "embed_model", "unit_count")
_UNIT_COLS = ("idx", "kind", "label", "text", "content_hash", "token_count", "equations", "needs_vision", "vision_reasons",
              "vision_status", "vision_notes", "vision_relevant")


class ExportScope(BaseModel):
    subject_id: int | None = None
    topic_id: int | None = None
    document_ids: list[int] | None = None


class ExportBody(ExportScope):
    include_notes: bool = True
    path: str | None = None  # where to write the zip; without one it is sent back as a download


class ImportBody(BaseModel):
    path: str
    subject_id: int | None = None  # import into this subject; None makes a new one
    subject_name: str | None = None  # the new subject's name (default: the pack's)


# ---------------------------------------------------------------- export

def _scope(b: ExportScope) -> tuple[dict, list[dict], str]:
    """(subject, documents in id order, label). A subject includes its reference library."""
    if b.document_ids:
        marks = ",".join("?" * len(b.document_ids))
        docs = db.q(f"SELECT * FROM documents WHERE id IN ({marks}) ORDER BY id", tuple(b.document_ids))
        if not docs:
            raise HTTPException(404, "No such files")
        if len({d["subject_id"] for d in docs}) > 1:
            raise HTTPException(400, "Export files from one subject at a time")
        label = docs[0]["filename"] if len(docs) == 1 else f"{len(docs)} files"
    elif b.topic_id is not None:
        t = db.q1("SELECT * FROM topics WHERE id=?", (b.topic_id,))
        if t is None:
            raise HTTPException(404, "Topic not found")
        docs = db.q("SELECT * FROM documents WHERE topic_id=? ORDER BY id", (b.topic_id,))
        label = t["name"]
    elif b.subject_id is not None:
        docs = db.q("SELECT * FROM documents WHERE subject_id=? AND kind<>'trash' ORDER BY id", (b.subject_id,))
        label = None
    else:
        raise HTTPException(400, "Choose a subject, topic or files")
    sid = docs[0]["subject_id"] if docs else b.subject_id
    subject = db.q1("SELECT * FROM subjects WHERE id=?", (sid,)) if sid else None
    if subject is None:
        raise HTTPException(404, "Subject not found")
    return subject, docs, label or subject["name"]


def _annotated(doc_id) -> int:
    """How many of the student's own marks a document has (highlights, notes, ink, text boxes)."""
    return db.q1("SELECT COUNT(*) n FROM annotations WHERE document_id=?", (doc_id,))["n"]


def _strip_notes(text: str) -> str:
    """Unit text from an older pack without the student's annotations folded into it."""
    return pipeline.without_annotations(text)


@router.post("/export/preview")
def export_preview(b: ExportScope):
    subject, docs, label = _scope(b)
    unready = [d["filename"] for d in docs if d["status"] not in ("ready", "vision")]
    ready = [d for d in docs if d["status"] in ("ready", "vision")]
    return {"label": label, "subject": subject["name"], "documents": len(ready), "skipped": unready,
            "size": sum(d["size"] for d in ready), "embed_model": llm.embed_model(),
            "annotated": [{"id": d["id"], "filename": d["filename"], "marks": n} for d in ready if (n := _annotated(d["id"]))]}


def _embed_missing(chunks: list[dict]):
    """Give every chunk without a current vector one (chunks rebuilt for a file that carries content it shared)."""
    model = llm.embed_model()
    todo = [c for c in chunks if c["embedding"] is None or c["embed_model"] != model]
    batch = int(db.setting("embed_batch"))
    for i in range(0, len(todo), batch):
        part = todo[i:i + batch]
        for c, v in zip(part, llm.embed([c["text"] for c in part])):
            c["embedding"], c["embed_model"] = v.astype(np.float32).tobytes(), model


def _pack_document(doc: dict, keys: dict[int, str], unit_keys: dict[int, tuple]) -> dict:
    """A document's units and chunks as the pack holds them (see the module notes)."""
    units = db.q("SELECT * FROM units WHERE document_id=? ORDER BY idx", (doc["id"],))
    changed = False
    out_units = []
    for u in units:
        row = {k: u[k] for k in _UNIT_COLS}
        row["images"] = [Path(p).name for p in json.loads(u["images"])]
        row["vision_reasons"] = json.loads(u["vision_reasons"])
        row["vision_image"] = Path(u["vision_image"]).name if u["vision_image"] else None
        row["duplicate_of"] = None
        if u["duplicate_of"] is not None:
            target = unit_keys.get(u["duplicate_of"])
            if target and target[0] in keys.values():
                row["duplicate_of"] = list(target)
            else:  # its original isn't in the pack: it carries its own content, vision notes included
                changed = True
                src = db.q1("SELECT vision_status, vision_notes, vision_relevant FROM units WHERE id=?", (u["duplicate_of"],))
                if src and src["vision_status"] == "done":
                    row.update(needs_vision=1, vision_status="done", vision_notes=src["vision_notes"],
                               vision_relevant=src["vision_relevant"])
        out_units.append(row)

    stored = db.q("SELECT unit_start, unit_end, label, text, token_count, source, embedding, embed_model FROM chunks "
                  "WHERE document_id=? ORDER BY id", (doc["id"],))
    if not changed:
        chunks = stored
    else:
        target, max_slides = int(db.setting("chunk_target_tokens")), int(db.setting("chunk_max_slides"))
        kept = [u for u in out_units if u["duplicate_of"] is None]
        flagged = {r["idx"] for r in db.q("""SELECT u.idx FROM vision_flags f JOIN units u ON u.id=f.unit_id WHERE f.document_id=?
                                              AND f.source='rule' AND f.kind='malformed' AND f.dismissed=0""", (doc["id"],))}
        seen = [u for u in kept if u["vision_status"] == "done" and u["vision_relevant"] and u["vision_notes"] and u["idx"] not in flagged]
        chunks = [{**c, "source": "text"} for c in chunk_units(kept, target, max_slides)]
        chunks += [{**c, "source": "vision"} for c in pipeline.vision_chunks(seen, target)]
        reuse = pipeline._vectors(stored)
        for c in chunks:
            c["embedding"], c["embed_model"] = reuse.get(c["text"], (None, None))
        _embed_missing(chunks)
    return {"units": out_units, "chunks": chunks}


@router.post("/export")
def export_pack(b: ExportBody):
    chosen = grants.require(b.path, "write") if b.path else None  # before any work: only where the student chose
    subject, docs, label = _scope(b)
    docs = [d for d in docs if d["status"] in ("ready", "vision")]
    if not docs:
        raise HTTPException(400, "Nothing to export: no file in this selection has finished ingesting")
    keys = {d["id"]: f"d{i}" for i, d in enumerate(docs, 1)}
    unit_keys = {r["id"]: (keys[r["document_id"]], r["idx"]) for r in db.q(
        f"SELECT id, document_id, idx FROM units WHERE document_id IN ({','.join('?' * len(keys))})", tuple(keys))}
    topics = {}
    for d in docs:
        if d["topic_id"] and d["topic_id"] not in topics:
            t = db.q1("SELECT name, description FROM topics WHERE id=?", (d["topic_id"],))
            topics[d["topic_id"]] = {"key": f"t{len(topics) + 1}", **t}

    if chosen:
        dest = chosen
    else:
        fd, name = tempfile.mkstemp(suffix=".zip", prefix="apollo-pack-")
        os.close(fd)
        dest = Path(name)
    dims = set()
    manifest_docs = []
    tmp = dest.with_name(dest.name + ".part")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            for d in docs:
                key = keys[d["id"]]
                data = _pack_document(d, keys, unit_keys)
                vecs, chunks = [], []
                for c in data["chunks"]:
                    row = {k: c[k] for k in ("unit_start", "unit_end", "label", "text", "token_count", "source")}
                    row["embed_model"], row["vec"] = c["embed_model"], None
                    if c["embedding"] is not None:
                        v = np.frombuffer(c["embedding"], dtype=np.float32)
                        if vecs and v.shape != vecs[0].shape:  # vectors of another size (an older model): leave out
                            row["embed_model"] = None
                        else:
                            row["vec"] = len(vecs)
                            vecs.append(v)
                    chunks.append(row)
                if vecs:
                    dims.add(int(vecs[0].shape[0]))
                    buf = io.BytesIO()
                    np.save(buf, np.vstack(vecs), allow_pickle=False)
                    z.writestr(f"data/{key}.npy", buf.getvalue())
                notes = b.include_notes and _annotated(d["id"])
                annotations = db.q("SELECT unit, kind, anchor, data, created_at, updated_at FROM annotations WHERE document_id=?",
                                   (d["id"],)) if notes else []
                z.writestr(f"data/{key}.json", json.dumps({"units": data["units"], "chunks": chunks, "annotations": annotations,
                                                           "render_map": d["render_map"]}, ensure_ascii=False))
                src = pipeline.doc_path(d)
                if src.is_file():
                    z.write(src, f"files/{d['sha256']}{d['ext']}")
                pdf = render.renders_dir() / f"{d['sha256']}.pdf"
                if pdf.is_file():
                    z.write(pdf, f"renders/{d['sha256']}.pdf", compress_type=zipfile.ZIP_STORED)
                asset_dir = config.assets_dir() / str(d["id"])
                if asset_dir.is_dir():
                    for f in asset_dir.iterdir():
                        if f.is_file() and _SAFE.match(f.name):
                            z.write(f, f"assets/{key}/{f.name}", compress_type=zipfile.ZIP_STORED)
                manifest_docs.append({"key": key, **{k: d[k] for k in _DOC_COLS},
                                      "topic": topics[d["topic_id"]]["key"] if d["topic_id"] else None,
                                      "notes": bool(notes), "file": src.is_file()})
            manifest = {"format": FORMAT, "version": VERSION, "created_at": time.time(), "scope": label,
                        "subject": {k: subject[k] for k in ("name", "color", "icon_text", "icon_emoji", "icon_name")},
                        "topics": [{k: t[k] for k in ("key", "name", "description")} for t in topics.values()],
                        "embed_model": llm.embed_model(), "embed_dim": max(dims) if dims else None,
                        "notes_included": b.include_notes, "documents": manifest_docs}
            z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        tmp.replace(dest)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    if not b.path:
        safe = re.sub(r"[^\w .-]+", "", label).strip() or "Apollo"
        return FileResponse(dest, media_type="application/zip", filename=f"{safe}.apollo.zip")
    return {"path": str(dest), "documents": len(docs), "bytes": dest.stat().st_size}


# ---------------------------------------------------------------- import

def _open(path: str) -> tuple[zipfile.ZipFile, dict]:
    p = grants.require(path)
    if not p.is_file():
        raise HTTPException(404, "File not found")
    try:
        z = zipfile.ZipFile(p)
        manifest = json.loads(z.read("manifest.json"))
    except (zipfile.BadZipFile, KeyError, json.JSONDecodeError):
        raise HTTPException(400, "Not an Apollo study pack (no readable manifest.json)")
    if manifest.get("format") != FORMAT:
        z.close()
        raise HTTPException(400, "Not an Apollo study pack")
    if int(manifest.get("version", 0)) > VERSION:
        z.close()
        raise HTTPException(400, "This pack was made by a newer version of Apollo Study: update the app to import it")
    if sum(i.file_size for i in z.infolist()) > MAX_UNPACKED:
        z.close()
        raise HTTPException(400, "This pack is too large to import")
    for d in manifest.get("documents", []):
        if not (_SAFE.match(str(d.get("key", ""))) and re.fullmatch(r"[0-9a-f]{64}", str(d.get("sha256", "")))
                and str(d.get("ext", "")).lower() in SUPPORTED and d.get("kind") in ("topic", "reference")):
            z.close()
            raise HTTPException(400, "The pack's manifest is damaged")
    return z, manifest


@router.post("/import/preview")
def import_preview(b: ImportBody):
    z, m = _open(b.path)
    z.close()
    same_model = m.get("embed_model") == llm.embed_model()
    return {"subject": m["subject"]["name"], "scope": m.get("scope"), "topics": [t["name"] for t in m.get("topics", [])],
            "documents": [{"filename": d["filename"], "kind": d["kind"], "notes": d.get("notes", False)} for d in m["documents"]],
            "notes_included": m.get("notes_included", False), "embed_model": m.get("embed_model"),
            "current_model": llm.embed_model(), "same_model": same_model, "created_at": m.get("created_at")}


def _read(z: zipfile.ZipFile, name: str) -> bytes | None:
    try:
        return z.read(name)
    except KeyError:
        return None


@router.post("/import")
def import_pack(b: ImportBody):
    z, m = _open(b.path)
    with z:
        return _import(z, m, b)


def _import(z: zipfile.ZipFile, m: dict, b: ImportBody) -> dict:
    now = time.time()
    if b.subject_id is not None:
        if not db.q1("SELECT id FROM subjects WHERE id=?", (b.subject_id,)):
            raise HTTPException(404, "Subject not found")
        sid = b.subject_id
    else:
        s = m["subject"]
        sid = db.ex("INSERT INTO subjects(name, color, icon_text, icon_emoji, icon_name, created_at) VALUES (?,?,?,?,?,?)",
                    ((b.subject_name or s.get("name") or "Imported").strip()[:120], s.get("color") or "#7c8cff",
                     s.get("icon_text"), s.get("icon_emoji"), s.get("icon_name"), now))
    existing = {t["name"].casefold(): t["id"] for t in db.q("SELECT id, name FROM topics WHERE subject_id=?", (sid,))}
    topic_ids = {}
    for t in m.get("topics", []):
        name = str(t.get("name") or "Imported").strip()[:200]
        if name.casefold() not in existing:
            existing[name.casefold()] = db.ex("INSERT INTO topics(subject_id, name, description, created_at) VALUES (?,?,?,?)",
                                               (sid, name, str(t.get("description") or ""), now))
        topic_ids[t["key"]] = existing[name.casefold()]

    model = llm.embed_model()
    new_ids, skipped, unit_ids, unresolved = {}, [], {}, set()
    for d in m["documents"]:
        key, ext = d["key"], d["ext"].lower()
        topic_id = topic_ids.get(d.get("topic")) if d["kind"] == "topic" else None
        kind = "topic" if topic_id else "reference"
        scope_sql, scope_arg = ("topic_id=? AND kind='topic'", topic_id) if topic_id else ("subject_id=? AND kind='reference'", sid)
        dup = db.q1(f"SELECT filename FROM documents WHERE {scope_sql} AND sha256=?", (scope_arg, d["sha256"]))
        if dup:
            skipped.append({"filename": d["filename"], "reason": f"already there as {dup['filename']}"})
            continue
        stored = config.files_dir() / f"{d['sha256']}{ext}"
        if not stored.exists() and not _copy_file(z, f"files/{d['sha256']}{ext}", stored, d["sha256"]):
            skipped.append({"filename": d["filename"], "reason": "the original file is missing or damaged in the pack"})
            continue
        data = json.loads(_read(z, f"data/{key}.json") or b"{}")
        if not data.get("units"):
            skipped.append({"filename": d["filename"], "reason": "no content in the pack"})
            continue
        npy = _read(z, f"data/{key}.npy")
        vecs = np.load(io.BytesIO(npy), allow_pickle=False).astype(np.float32) if npy else None
        stripped = False
        for u in data["units"]:  # an older pack may have the sender's notes folded into the text
            text = str(u.get("text") or "")
            if pipeline.ANNOTATIONS_HEADER in text:
                u["text"] = _strip_notes(text)
                u["token_count"], stripped = approx_tokens(u["text"]), True
        did = _insert_document(sid, topic_id, kind, d, data, vecs, stored.stat().st_size, now)
        if stripped:
            unresolved.add(did)  # chunks rebuilt from the clean text; unchanged chunk text keeps its vector
        new_ids[key] = did
        _copy_assets(z, key, did)
        if d.get("ext") in render.OFFICE_EXTS:
            pdf = _read(z, f"renders/{d['sha256']}.pdf")
            out = render.renders_dir() / f"{d['sha256']}.pdf"
            if pdf and pdf[:5] == b"%PDF-" and not out.exists():
                out.write_bytes(pdf)
        for u in db.q("SELECT id, idx FROM units WHERE document_id=?", (did,)):
            unit_ids[(key, u["idx"])] = u["id"]
        for u in data["units"]:  # links inside the pack; a link to a skipped file is worked out again below
            ref = u.get("duplicate_of")
            if ref:
                target = unit_ids.get(tuple(ref))
                if target:
                    db.ex("UPDATE units SET duplicate_of=? WHERE document_id=? AND idx=?", (target, did, u["idx"]))
                else:
                    unresolved.add(did)

    ids = list(new_ids.values())
    need_embed = set(pipeline.relink(ids, rebuild=unresolved))
    if ids:
        vision_audit.rule_scan(ids)
    for did in ids:
        if db.q1("SELECT 1 FROM chunks WHERE document_id=? AND (embedding IS NULL OR embed_model IS NOT ?) LIMIT 1", (did, model)):
            need_embed.add(did)
        if db.q1("SELECT 1 FROM units WHERE document_id=? AND vision_status IN ('pending','failed') AND duplicate_of IS NULL "
                 "LIMIT 1", (did,)):
            jobs.enqueue("vision", did)
    for did in need_embed:
        jobs.enqueue("embed", did)
    return {"subject_id": sid, "imported": len(ids), "skipped": skipped, "reembedding": len(need_embed),
            "same_model": m.get("embed_model") == model}


def _insert_document(sid, topic_id, kind, d, data, vecs, size, now) -> int:
    model = llm.embed_model()
    units, chunks = data["units"], data.get("chunks", [])
    kept = [u for u in units if not u.get("duplicate_of")]
    vision_total = sum(1 for u in kept if u.get("needs_vision"))
    vision_done = sum(1 for u in kept if u.get("needs_vision") and u.get("vision_status") == "done")
    notes_at = now if data.get("annotations") else None
    with db.tx() as c:
        did = c.execute(
            "INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
            "token_count, chunk_count, duplicate_units, vision_total, vision_done, parser_version, embed_model, render_map, "
            "vision_indexed, annotated_at, annotations_ingested, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)",
            (sid, topic_id, kind, str(d["filename"])[:255], d["ext"].lower(), d["sha256"], size, d.get("vision_mode") or "off",
             len(units), sum(int(u.get("token_count") or 0) for u in kept), len(chunks), len(units) - len(kept),
             vision_total, vision_done, d.get("parser_version"), d.get("embed_model"), _render_map(data.get("render_map")),
             notes_at, notes_at, now, now)).lastrowid
        for u in units:
            images = [f"{did}/{n}" for n in u.get("images", []) if _SAFE.match(str(n))]
            vimg = u.get("vision_image")
            c.execute("INSERT INTO units(document_id, idx, kind, label, text, content_hash, duplicate_of, token_count, equations, "
                      "images, vision_image, needs_vision, vision_reasons, vision_status, vision_notes, vision_relevant) "
                      "VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?)",
                      (did, int(u["idx"]), str(u.get("kind") or "page"), str(u.get("label") or ""), str(u.get("text") or ""),
                       str(u["content_hash"]), int(u.get("token_count") or 0), int(u.get("equations") or 0), json.dumps(images),
                       f"{did}/{vimg}" if vimg and _SAFE.match(str(vimg)) else None, int(bool(u.get("needs_vision"))),
                       json.dumps(u.get("vision_reasons") or []), str(u.get("vision_status") or "none"),
                       u.get("vision_notes"), u.get("vision_relevant")))
        for ch in chunks:
            vec = None
            i = ch.get("vec")
            if vecs is not None and isinstance(i, int) and 0 <= i < len(vecs):
                vec = vecs[i].tobytes()
            emb_model = ch.get("embed_model") if vec is not None else None
            if emb_model != model:  # another model's vectors can't be compared with this one's: made again here
                vec, emb_model = None, None
            cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count, source, embedding, "
                            "embed_model) VALUES (?,?,?,?,?,?,?,?,?)",
                            (did, int(ch["unit_start"]), int(ch["unit_end"]), str(ch.get("label") or ""), str(ch["text"]),
                             int(ch.get("token_count") or 0), "vision" if ch.get("source") == "vision" else "text", vec, emb_model)).lastrowid
            c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, str(ch["text"])))
        for a in data.get("annotations", []):
            c.execute("INSERT INTO annotations(document_id, unit, kind, anchor, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                      (did, int(a["unit"]), str(a["kind"]), str(a.get("anchor") or "{}"), str(a.get("data") or "{}"), now, now))
    return did


def _render_map(raw) -> str | None:
    """A pack's section → [page, y] map, only if it really is one (the viewer and annotations read it)."""
    try:
        m = json.loads(raw) if isinstance(raw, str) else None
        ok = isinstance(m, dict) and all(isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) for x in v)
                                         for v in m.values())
        return json.dumps(m) if ok else None
    except ValueError:
        return None


def _copy_file(z: zipfile.ZipFile, member: str, out: Path, sha: str) -> bool:
    """Stream an original file out of the pack, keeping it only if its SHA-256 is the one the manifest names."""
    tmp = out.with_name(out.name + ".part")
    h = hashlib.sha256()
    try:
        with z.open(member) as src, open(tmp, "wb") as dst:
            for block in iter(lambda: src.read(1 << 20), b""):
                h.update(block)
                dst.write(block)
    except KeyError:
        return False
    if h.hexdigest() != sha:
        tmp.unlink(missing_ok=True)
        return False
    tmp.replace(out)
    return True


def _copy_assets(z: zipfile.ZipFile, key: str, did: int):
    prefix = f"assets/{key}/"
    for info in z.infolist():
        if not info.filename.startswith(prefix) or info.is_dir():
            continue
        name = info.filename[len(prefix):]
        if not _SAFE.match(name):
            continue
        out = config.assets_dir() / str(did)
        out.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(z.read(info))
