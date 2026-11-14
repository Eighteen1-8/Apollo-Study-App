"""The student's own notes, Apollo's reviews of notes and generated content, highlights on generated content, and
Word export.

Notes are rich-text HTML from the notes editor. They are never ingested (they may be wrong): nothing adds them to the
material, search or the chat's context. Apollo reads one only when the student asks it to check or revise it (a
review, see review.py) or asks about it in chat (chat tools read_content / revise_content).

A note's `kind` is 'note' (HTML in `html`), 'map' (a mind map / flowchart: `data` is {nodes:[{id,x,y,text,shape,color}],
edges:[{id,from,to,label}]}) or 'drawing' (`data` is the drawing editor's vector JSON, {items:[...], paper}; a PNG
snapshot the editor renders is stored for Check with Apollo, see snapshot_path)."""
import base64
import binascii
import io
import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from . import config, db, docx_export, grants, jobs, notehtml

router = APIRouter()

REVIEW_TARGETS = ("note", "artifact")
REVIEWABLE_TYPES = ("notes", "cheatsheet")
# generated content chat can read (list_content / read_content), as the model is told it; a marking is read only
ARTIFACT_KINDS = {"notes": "generated notes", "cheatsheet": "generated cheat sheet",
                  "marking": "Apollo's marking of the student's work (read only)"}
NOTE_KINDS = ("note", "map", "drawing")
KIND_NAMES = {"note": "the student's own note", "map": "the student's own mind map", "drawing": "the student's own drawing"}
DEFAULT_TITLES = {"note": "Untitled note", "map": "Untitled mind map", "drawing": "Untitled drawing"}
MAX_DATA = 8 << 20  # a map's or drawing's JSON (a long drawing is many points)
MAX_SNAPSHOT = 12 << 20


def _note(nid):
    n = db.q1("SELECT * FROM user_notes WHERE id=? AND deleted_at IS NULL", (nid,))
    if n is None:
        raise HTTPException(404, "Note not found")
    return note_out(n)


def note_out(n) -> dict:
    """A user_notes row with `data` parsed (None for a rich-text note)."""
    n = dict(n)
    try:
        n["data"] = json.loads(n["data"]) if n.get("data") else None
    except ValueError:
        n["data"] = None
    return n


def _checked_data(kind: str, data) -> str | None:
    """The JSON stored for a map or drawing (None for a rich-text note); 400 when it's the wrong shape or too big."""
    if kind == "note" or data is None:
        return None
    if not isinstance(data, dict):
        raise HTTPException(400, "A map or drawing must be an object")
    if kind == "map" and not (isinstance(data.get("nodes", []), list) and isinstance(data.get("edges", []), list)):
        raise HTTPException(400, "A mind map needs lists of boxes and links")
    if kind == "drawing" and not isinstance(data.get("items", []), list):
        raise HTTPException(400, "A drawing needs a list of strokes")
    text = json.dumps(data, separators=(",", ":"))
    if len(text) > MAX_DATA:
        raise HTTPException(413, "[APO-APP-400] That is too big to save. Split it into two.")
    return text


def snapshot_path(nid: int) -> Path:
    """Where a drawing's latest PNG snapshot (made by the editor for Check with Apollo) is kept."""
    return config.assets_dir() / "notes" / f"{int(nid)}.png"


def delete_snapshots(ids) -> None:
    for i in ids:
        try:
            snapshot_path(i).unlink(missing_ok=True)
        except OSError:
            pass


# ---------------------------------------------------------------- notes

class NewNote(BaseModel):
    title: str = ""
    topic_id: int | None = None
    html: str = ""
    kind: str = "note"
    data: dict | None = None


class NotePatch(BaseModel):
    title: str | None = None
    html: str | None = None
    data: dict | None = None  # a map's or drawing's JSON
    topic_id: int | None = None
    set_topic: bool = False  # topic_id may legitimately be null (= the whole subject)


@router.get("/subjects/{sid}/notes")
def list_notes(sid: int):
    return db.q("""SELECT n.id, n.subject_id, n.topic_id, n.title, n.kind, n.created_at, n.updated_at,
                          t.name AS topic_name, LENGTH(n.html) + COALESCE(LENGTH(n.data), 0) AS size FROM user_notes n LEFT JOIN topics t ON t.id=n.topic_id
                   WHERE n.subject_id=? AND n.deleted_at IS NULL ORDER BY n.updated_at DESC""", (sid,))


@router.post("/subjects/{sid}/notes")
def create_note(sid: int, body: NewNote):
    if not db.q1("SELECT id FROM subjects WHERE id=?", (sid,)):
        raise HTTPException(404, "Subject not found")
    if body.kind not in NOTE_KINDS:
        raise HTTPException(400, "A note is a note, a mind map or a drawing")
    data = _checked_data(body.kind, body.data if body.data is not None or body.kind == "note" else {})
    now = time.time()
    nid = db.ex("INSERT INTO user_notes(subject_id, topic_id, title, html, kind, data, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (sid, body.topic_id, body.title.strip()[:200] or DEFAULT_TITLES[body.kind],
                 notehtml.scrub(body.html) if body.kind == "note" else "", body.kind, data, now, now))
    return _note(nid)


@router.get("/notes/{nid}")
def get_note(nid: int):
    return _note(nid)


@router.patch("/notes/{nid}")
def patch_note(nid: int, body: NotePatch):
    n = _note(nid)
    fields: dict = {}
    if body.title is not None:
        fields["title"] = body.title.strip()[:200] or DEFAULT_TITLES.get(n["kind"], "Untitled note")
    if body.html is not None and n["kind"] == "note":
        fields["html"] = notehtml.scrub(body.html)
    if body.data is not None:
        if n["kind"] == "note":
            raise HTTPException(400, "A rich-text note has no map or drawing data")
        fields["data"] = _checked_data(n["kind"], body.data)
    if body.set_topic:
        fields["topic_id"] = body.topic_id
    if fields:
        fields["updated_at"] = time.time()
        db.ex(f"UPDATE user_notes SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), nid))
    return _note(nid)


@router.delete("/notes/{nid}")
def delete_note(nid: int):
    """Soft delete (undoable with POST /notes/{id}/restore); purged after a week with its reviews
    (study_api.purge_deleted)."""
    db.ex("UPDATE user_notes SET deleted_at=? WHERE id=? AND deleted_at IS NULL", (time.time(), nid))
    return {"ok": True}


@router.post("/notes/{nid}/restore")
def restore_note(nid: int):
    db.ex("UPDATE user_notes SET deleted_at=NULL WHERE id=?", (nid,))
    return {"ok": True}


class Snapshot(BaseModel):
    png: str  # base64 PNG (a data: URL prefix is allowed), rendered by the drawing editor


@router.post("/notes/{nid}/snapshot")
def put_snapshot(nid: int, body: Snapshot):
    """Store the picture of a drawing that Check with Apollo sends to the model (one per drawing, replaced each time)."""
    n = _note(nid)
    if n["kind"] != "drawing":
        raise HTTPException(400, "Only drawings have a picture to check")
    data, w, h = _png_bytes(body.png)
    config.write_atomic(snapshot_path(nid), data)
    return {"ok": True, "width": w, "height": h}


def _png_bytes(b64: str) -> tuple[bytes, int, int]:
    """A base64 PNG (a data: URL prefix is allowed) checked with PIL: (bytes, width, height); 400/413 otherwise."""
    raw = b64.split(",", 1)[1] if b64.startswith("data:") else b64
    if len(raw) > MAX_SNAPSHOT * 4 // 3 + 8:
        raise HTTPException(413, "[APO-APP-400] That picture is too big. Make it smaller.")
    try:
        data = base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(400, "That picture couldn't be read.") from e
    from PIL import Image
    try:
        with Image.open(io.BytesIO(data)) as im:
            if im.format != "PNG":
                raise ValueError(im.format)
            im.verify()
            w, h = im.size
    except Exception as e:
        raise HTTPException(400, "That picture couldn't be read.") from e
    if not (0 < w <= 8000 and 0 < h <= 8000):
        raise HTTPException(400, "That picture is too large.")
    return data, w, h


class PngBody(BaseModel):
    png: str  # base64 PNG
    path: str  # where to save it (a save dialog grant)


@router.post("/export/png")
def export_png(body: PngBody):
    """Save a mind map or drawing the editor rendered as a PNG where the student chose (the desktop app's save dialog)."""
    data, _, _ = _png_bytes(body.png)
    out = grants.require(body.path, "write")
    try:
        Path(out).write_bytes(data)
    except PermissionError as e:
        raise HTTPException(409, f"Couldn't save {Path(out).name}: it's open in another program, or that folder "
                                 "can't be written to.") from e
    return {"path": str(out)}


# ---------------------------------------------------------------- content Apollo can read and revise (chat tools)

def list_content(subject_id: int) -> list[dict]:
    """The student's notes and the generated notes / cheat sheets / markings of a subject: what chat can read (and,
    except a marking, check or revise)."""
    notes = db.q("SELECT id, title, kind, updated_at FROM user_notes WHERE subject_id=? AND deleted_at IS NULL "
                 "ORDER BY updated_at DESC", (subject_id,))
    arts = db.q(f"""SELECT id, title, type, updated_at FROM artifacts WHERE subject_id=? AND status='ready'
                   AND deleted_at IS NULL AND type IN ({','.join('?' * len(ARTIFACT_KINDS))}) ORDER BY id DESC""",
                (subject_id, *ARTIFACT_KINDS))
    return ([{"target": "note", "id": n["id"], "title": n["title"], "kind": KIND_NAMES.get(n["kind"], KIND_NAMES["note"]),
             "note_kind": n["kind"]} for n in notes]
            + [{"target": "artifact", "id": a["id"], "title": a["title"], "kind": ARTIFACT_KINDS[a["type"]],
                "type": a["type"]} for a in arts])


def _words(s: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def find_content(subject_id: int, title: str) -> dict | None:
    """The note or generated content best matching a title the model wrote (exact, then contained, then most words)."""
    items = list_content(subject_id)
    t = title.strip().lower()
    for test in (lambda i: i["title"].lower() == t, lambda i: t and (t in i["title"].lower() or i["title"].lower() in t)):
        hit = next((i for i in items if test(i)), None)
        if hit:
            return hit
    want = _words(title)
    best = max(items, key=lambda i: len(want & _words(i["title"])), default=None)
    return best if best and want & _words(best["title"]) else None


# ---------------------------------------------------------------- reviews

class NewReview(BaseModel):
    target: str  # note | artifact
    target_id: int
    mode: str  # check | revise
    quote: str = ""
    section: int | None = None
    instruction: str = ""


def _review_out(r):
    r = dict(r)
    r["result"] = json.loads(r["result"]) if r["result"] else None
    return r


def create_review(subject_id: int | None, body: NewReview, chat_id: int | None = None) -> dict:
    if body.target not in REVIEW_TARGETS or body.mode not in ("check", "revise"):
        raise HTTPException(400, "Unknown review")
    if body.target == "note":
        owner = _note(body.target_id)
        if owner["kind"] != "note" and body.mode != "check":
            raise HTTPException(400, "Apollo can check a mind map or drawing, but not rewrite it")
        if owner["kind"] == "drawing" and not snapshot_path(owner["id"]).is_file():
            raise HTTPException(400, "Save the drawing's picture first (Check with Apollo does this)")
    else:
        owner = db.q1("SELECT * FROM artifacts WHERE id=?", (body.target_id,))
        if owner is not None and owner["type"] == "marking":
            raise HTTPException(400, "Apollo's marking can be read and asked about, but not checked or rewritten")
        if owner is None or owner["status"] != "ready" or owner["type"] not in REVIEWABLE_TYPES:
            raise HTTPException(400, "Only finished notes and cheat sheets can be checked or revised")
    if body.mode == "revise" and not body.instruction.strip():
        raise HTTPException(400, "Say what Apollo should change")
    now = time.time()
    rid = db.ex("""INSERT INTO reviews(subject_id, target, target_id, section, quote, instruction, mode, status, message,
                   chat_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (subject_id or owner["subject_id"], body.target, body.target_id, body.section, body.quote.strip()[:4000],
                 body.instruction.strip()[:2000], body.mode, "queued", "Waiting for Apollo…", chat_id, now, now))
    jobs.enqueue("review", ref_id=rid, label=f"{'Check' if body.mode == 'check' else 'Revise'}: {owner['title']}")
    return get_review(rid)


@router.post("/reviews")
def post_review(body: NewReview):
    return create_review(None, body)


@router.get("/reviews")
def list_reviews(target: str, target_id: int):
    return [_review_out(r) for r in db.q("SELECT * FROM reviews WHERE target=? AND target_id=? AND dismissed=0 ORDER BY id DESC",
                                         (target, target_id))]


@router.get("/reviews/{rid}")
def get_review(rid: int):
    r = db.q1("SELECT * FROM reviews WHERE id=?", (rid,))
    if r is None:
        raise HTTPException(404, "Review not found")
    out = _review_out(r)
    if r["target"] == "note":
        n = db.q1("SELECT title FROM user_notes WHERE id=?", (r["target_id"],))
    else:
        n = db.q1("SELECT title FROM artifacts WHERE id=?", (r["target_id"],))
    out["target_title"] = n["title"] if n else None
    return out


def _swap_sections(r: dict, new: list[dict]) -> list[dict]:
    """Put `new` [{index, html|markdown, figures?}] into the review's target; returns what was there before."""
    now = time.time()
    if r["target"] == "note":
        n = _note(r["target_id"])
        if not new:
            raise HTTPException(400, "Nothing to put back")
        db.ex("UPDATE user_notes SET html=?, updated_at=? WHERE id=?", (notehtml.scrub(new[0].get("html") or ""), now, n["id"]))
        return [{"index": 0, "html": n["html"]}]
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (r["target_id"],))
    if a is None or not a["content"]:
        raise HTTPException(404, "That content was deleted")
    content = json.loads(a["content"])
    secs = content.get("sections") or []
    before = []
    for s in new:
        i = s["index"]
        if not 0 <= i < len(secs):
            continue
        old = secs[i]
        before.append({"index": i, **{k: old[k] for k in ("html", "markdown", "figures") if k in old}})
        for k in ("html", "markdown", "figures"):
            old.pop(k, None)
        old.update({k: s[k] for k in ("html", "markdown", "figures") if k in s})
    db.ex("UPDATE artifacts SET content=?, updated_at=? WHERE id=?", (json.dumps(content), now, a["id"]))
    return before


@router.post("/reviews/{rid}/apply")
def apply_review(rid: int):
    r = db.q1("SELECT * FROM reviews WHERE id=?", (rid,))
    if r is None or r["status"] != "ready" or r["mode"] != "revise":
        raise HTTPException(400, "Nothing to apply")
    if r["applied"]:
        return get_review(rid)
    result = json.loads(r["result"])
    result["previous"] = _swap_sections(r, result["sections"])
    db.ex("UPDATE reviews SET applied=1, result=?, updated_at=? WHERE id=?", (json.dumps(result), time.time(), rid))
    return get_review(rid)


@router.post("/reviews/{rid}/undo")
def undo_review(rid: int):
    r = db.q1("SELECT * FROM reviews WHERE id=?", (rid,))
    if r is None or not r["applied"]:
        raise HTTPException(400, "Nothing to undo")
    result = json.loads(r["result"])
    _swap_sections(r, result.pop("previous", []))
    db.ex("UPDATE reviews SET applied=0, result=?, updated_at=? WHERE id=?", (json.dumps(result), time.time(), rid))
    return get_review(rid)


@router.post("/reviews/{rid}/dismiss")
def dismiss_review(rid: int):
    for j in db.q("SELECT id FROM jobs WHERE type='review' AND ref_id=? AND status IN ('queued','running')", (rid,)):
        jobs.cancel(j["id"])
    db.ex("UPDATE reviews SET dismissed=1, updated_at=? WHERE id=?", (time.time(), rid))
    return {"ok": True}


# ---------------------------------------------------------------- highlights on generated content

class MarkBody(BaseModel):
    section: int
    start: int
    end: int
    text: str
    color: str = "yellow"


@router.get("/artifacts/{aid}/marks")
def list_marks(aid: int):
    return db.q("SELECT * FROM artifact_marks WHERE artifact_id=? ORDER BY section, start", (aid,))


@router.post("/artifacts/{aid}/marks")
def add_mark(aid: int, body: MarkBody):
    if not db.q1("SELECT id FROM artifacts WHERE id=?", (aid,)):
        raise HTTPException(404, "Not found")
    mid = db.ex("INSERT INTO artifact_marks(artifact_id, section, start, end, text, color, created_at) VALUES (?,?,?,?,?,?,?)",
                (aid, body.section, body.start, body.end, body.text[:2000], body.color[:20], time.time()))
    return db.q1("SELECT * FROM artifact_marks WHERE id=?", (mid,))


class MarkPatch(BaseModel):
    start: int | None = None
    end: int | None = None
    color: str | None = None


@router.patch("/marks/{mid}")
def patch_mark(mid: int, body: MarkPatch):
    """Re-anchored after the section's text changed (a revision), or recoloured."""
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if fields:
        db.ex(f"UPDATE artifact_marks SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), mid))
    return db.q1("SELECT * FROM artifact_marks WHERE id=?", (mid,))


@router.delete("/marks/{mid}")
def delete_mark(mid: int):
    db.ex("DELETE FROM artifact_marks WHERE id=?", (mid,))
    return {"ok": True}


# ---------------------------------------------------------------- Word export

class DocxBody(BaseModel):
    title: str
    html: str  # built by the UI (exportDoc.ts): maths as LaTeX text, images as backend asset URLs
    path: str | None = None  # where to save (a save dialog grant); without it the file comes back as a download


@router.post("/export/docx")
def export_docx(body: DocxBody):
    data = docx_export.build(body.title, body.html)
    if body.path:
        out = grants.require(body.path, "write")
        try:
            Path(out).write_bytes(data)
        except PermissionError as e:  # usually: the file is open in Word
            raise HTTPException(409, f"Couldn't save {Path(out).name}: it's open in another program, or that folder "
                                     "can't be written to.") from e
        return {"path": str(out)}
    name = re.sub(r'[<>:"/\\|?*]+', " ", body.title).strip()[:80] or "export"
    return Response(data, media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    headers={"Content-Disposition": f'attachment; filename="{name}.docx"'})

