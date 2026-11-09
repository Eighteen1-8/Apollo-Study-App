"""Files sent straight to the chat for one message, without ingesting them: text files within the word limit, images kept
as PNG under assets/chat/ so later turns can still show them to Qwen. Paths need the student's grant (grants.py)."""
import json
import tempfile
from pathlib import Path

from fastapi import HTTPException
from PIL import Image

from . import config, db, grants
from .parsers import IMAGE_EXTS, SUPPORTED, parse, sha


def _read_chat_file(path_str: str) -> dict:
    """Read a file for one chat message without ingesting it. Text files must fit the word limit; images are kept
    as PNG under assets/chat/ so later turns can still show them to Qwen."""
    path = grants.require(path_str)
    ext = path.suffix.lower()
    if not path.is_file():
        raise HTTPException(400, f"[APO-FILE-301] {path.name}: file not found")
    if ext in IMAGE_EXTS:
        blob = path.read_bytes()
        rel = f"chat/{sha(blob)[:24]}.png"
        out = config.assets_dir() / rel
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            try:
                im = Image.open(path)
                im.thumbnail((2048, 2048))
                im.convert("RGB").save(out, "PNG")
            except Exception:
                raise HTTPException(400, f"[APO-FILE-304] {path.name}: couldn't read this image")
        out = {"name": path.name, "kind": "image", "asset": rel}
        snap = db.q1("SELECT document_id, unit, rect FROM snapshots WHERE path=?", (str(path.resolve()),))
        if snap:  # a screenshot from the viewer: remember where it came from
            out["source"] = {"document_id": snap["document_id"], "unit": snap["unit"], "rect": json.loads(snap["rect"])}
        return out
    if ext not in SUPPORTED:
        raise HTTPException(400, f"[APO-FILE-303] {path.name}: Apollo can't read {ext} files. Use PDF, PowerPoint, Word, text or an image.")
    with tempfile.TemporaryDirectory() as tmp:
        try:
            units, _ = parse(path, Path(tmp), {**config.DEFAULT_SETTINGS, **db.get_settings()})
        except Exception as e:
            raise HTTPException(400, f"[{'APO-FILE-305' if 'password' in str(e).lower() or 'encrypt' in str(e).lower() else 'APO-FILE-304'}] {path.name}: couldn't read this file ({e})")
    text = "\n\n".join(f"[{u['label']}]\n{u['text'].strip()}" for u in units if u["text"].strip())
    words = len(text.split())
    limit = int(db.setting("chat_file_word_limit"))
    if not words:
        raise HTTPException(400, f"[APO-FILE-306] {path.name} has no readable text (it may be scanned). Add it to a topic or the "
                                 "reference library so it's ingested (vision can read it), then ask about it.")
    if words > limit:
        raise HTTPException(413, f"[APO-FILE-307] {path.name} is too long to send straight to the chat ({words:,} words; the limit is "
                                 f"{limit:,}). Add it to a topic or the reference library so it's ingested, then ask about it.")
    return {"name": path.name, "kind": "text", "text": text, "words": words}
