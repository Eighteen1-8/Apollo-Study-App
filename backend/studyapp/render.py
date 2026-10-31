"""Exact copies of Office files for the viewer (and for slide images sent to vision).

PowerPoint/Word (Microsoft Office via COM, or LibreOffice) export a .pptx/.docx to PDF once; it's cached by file hash
under <data>/renders/. Text still comes from the native parsers. Without either program, the viewer falls back to
its HTML layout (viewer.py). Word sections don't line up with PDF pages, so `unit_positions` finds where each
section starts in the PDF (exact text search), which is how citations and annotations map between the two."""
import json
import re
import shutil
import subprocess
import threading
from pathlib import Path

import pymupdf

from . import config, db

OFFICE_EXTS = (".pptx", ".docx")
_lock = threading.Lock()
_failed: set[str] = set()  # file hashes that failed to convert this run (don't retry on every view)


def renders_dir() -> Path:
    d = config.DATA_DIR / "renders"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _office_available(kind: str) -> bool:
    import winreg
    try:
        winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "PowerPoint.Application" if kind == "pptx" else "Word.Application").Close()
        return True
    except OSError:
        return False


def _soffice() -> str | None:
    for p in (shutil.which("soffice"), r"C:\Program Files\LibreOffice\program\soffice.exe",
              r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"):
        if p and Path(p).is_file():
            return p
    return None


def _convert(src: Path, out: Path, kind: str) -> bool:
    try:
        if _office_available(kind):
            ps1 = Path(__file__).with_name("office_export.ps1")
            subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1), "-Kind", kind,
                            "-In", str(src), "-Out", str(out)], capture_output=True, timeout=300,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if out.exists():
                return True
    except Exception:
        pass
    soffice = _soffice()
    if soffice:
        try:
            tmp = out.parent / f"lo-{out.stem}"
            tmp.mkdir(exist_ok=True)
            subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", str(tmp), str(src)], capture_output=True,
                           timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            made = tmp / (src.stem + ".pdf")
            if made.exists():
                made.replace(out)
            shutil.rmtree(tmp, ignore_errors=True)
            return out.exists()
        except Exception:
            pass
    return False


def rendered_pdf(doc: dict, convert=True) -> Path | None:
    """The cached exact PDF of an Office file, converting it now if needed (and allowed)."""
    if doc["ext"] not in OFFICE_EXTS:
        return None
    out = renders_dir() / f"{doc['sha256']}.pdf"
    if out.exists() or not convert or doc["sha256"] in _failed:
        return out if out.exists() else None
    from .pipeline import doc_path
    with _lock:  # one Office conversion at a time
        if not out.exists():
            part = out.with_suffix(".part.pdf")
            ok = _convert(doc_path(doc), part, doc["ext"][1:])
            if ok:
                part.replace(out)
            else:
                part.unlink(missing_ok=True)
                _failed.add(doc["sha256"])
    return out if out.exists() else None


def viewer_pdf(doc: dict, convert=True) -> Path | None:
    """The PDF the viewer shows: the file itself, or the exact copy of an Office file."""
    if doc["ext"] == ".pdf":
        from .pipeline import doc_path
        return doc_path(doc)
    return rendered_pdf(doc, convert)


_norm = lambda s: re.sub(r"\s+", " ", s).strip().lower()  # noqa: E731


def unit_positions(doc: dict, units: list[dict] | None = None) -> dict[int, list[float]]:
    """Word only: {unit idx: [page, y fraction]} where each section's text starts in the exact PDF. Cached on the
    document; sections are searched in order, each from where the previous one was found."""
    if doc["ext"] != ".docx":
        return {}
    if units is None:  # from the cache, else the stored units
        cached = db.q1("SELECT render_map FROM documents WHERE id=?", (doc["id"],))
        if cached and cached["render_map"]:
            return {int(k): v for k, v in json.loads(cached["render_map"]).items()}
        units = db.q("SELECT idx, text FROM units WHERE document_id=? ORDER BY idx", (doc["id"],))
    pdf_path = rendered_pdf(doc, convert=False)
    if not pdf_path or not units:
        return {}
    pdf = pymupdf.open(pdf_path)
    pages = [_norm(p.get_text()) for p in pdf]
    out, page_i = {}, 0
    for u in units:
        lines = [ln.strip() for ln in u["text"].splitlines() if len(ln.strip()) >= 4 and not ln.startswith("[table]")]
        if not lines:
            continue
        probe = _norm(lines[0])[:60]
        for pi in range(page_i, len(pages)):
            if probe and probe in pages[pi]:
                page = pdf[pi]
                hits = page.search_for(lines[0][:40])
                y = (hits[0].y0 / page.rect.height) if hits else 0.0
                out[u["idx"]] = [pi + 1, round(y, 4)]
                page_i = pi
                break
    db.ex("UPDATE documents SET render_map=? WHERE id=?", (json.dumps(out), doc["id"]))
    return out


def unit_at(positions: dict[int, list[float]], page: int, y: float) -> int | None:
    """The Word section that a point in the exact PDF belongs to: the last section starting at or before it."""
    best = None
    for idx, (p, py) in sorted(positions.items(), key=lambda kv: (kv[1][0], kv[1][1])):
        if (p, py) <= (page, y + 0.002):
            best = idx
    return best
