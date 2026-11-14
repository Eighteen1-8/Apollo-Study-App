"""Exact copies of Office files for the viewer (and for slide images sent to vision).

PowerPoint/Word (Microsoft Office via COM, or LibreOffice) export a .pptx/.docx to PDF once; it's cached by file hash
under <data>/renders/. Text still comes from the native parsers. Without either program, the viewer falls back to
its HTML layout (viewer.py). Word sections don't line up with PDF pages, so `unit_positions` finds where each
section starts in the PDF (exact text search), which is how citations and annotations map between the two."""
import logging
import json
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pymupdf

from . import config, db

log = logging.getLogger(__name__)

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


TIMEOUT = 300  # seconds per export: a long deck in PowerPoint can take minutes, so this stays generous


def _tail(b: bytes | str | None) -> str:
    """The last meaningful line of a converter's output (PowerShell's error record, LibreOffice's message)."""
    text = b.decode("utf-8", "replace") if isinstance(b, bytes) else (b or "")
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith(("+", "~", "At "))]
    return lines[0][:300] if lines else ""


def _convert(src: Path, out: Path, kind: str) -> bool:
    return export_pdf(src, out, kind) is None


def export_pdf(src: Path, out: Path, kind: str) -> str | None:
    """Export src to out as PDF. None when it worked; otherwise why not, as "plain message [APO-FILE-3xx]" (the
    technical detail goes to the log)."""
    from . import errors
    reasons: list[str] = []
    office = _office_available(kind)
    try:
        if office:
            ps1 = Path(__file__).with_name("office_export.ps1")
            r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(ps1), "-Kind", kind,
                                "-In", str(src), "-Out", str(out)], capture_output=True, timeout=TIMEOUT,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if out.exists():
                return None
            why = _tail(r.stderr) or _tail(r.stdout) or f"exit code {r.returncode}"
            log.warning("Office export of %s produced no PDF: %s", src.name, why)
            reasons.append(f"Office: {why}")
    except subprocess.TimeoutExpired:
        log.warning("Office export of %s timed out after %ss", src.name, TIMEOUT)
        reasons.append("Office: timed out")
    except Exception as e:
        log.warning("Office export of %s failed", src.name, exc_info=True)
        reasons.append(f"Office: {e}")
    soffice = _soffice()
    if soffice:
        try:
            tmp = out.parent / f"lo-{out.stem}"
            tmp.mkdir(exist_ok=True)
            made = tmp / (src.stem + ".pdf")
            # hidden slides included, so page N is always slide N (as with Office); LibreOffice before 7.4 doesn't
            # take the JSON options, so it's tried again plainly
            kinds = (['pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}', "pdf"]
                     if src.suffix.lower() == ".pptx" else ["pdf"])
            why = ""
            for kind in kinds:
                r = subprocess.run([soffice, "--headless", "--convert-to", kind, "--outdir", str(tmp), str(src)], capture_output=True,
                                   timeout=TIMEOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if made.exists():
                    break
                why = _tail(r.stderr) or _tail(r.stdout) or f"exit code {r.returncode}"
            if made.exists():
                made.replace(out)
            shutil.rmtree(tmp, ignore_errors=True)
            if out.exists():
                return None
            log.warning("LibreOffice export of %s produced no PDF: %s", src.name, why)
            reasons.append(f"LibreOffice: {why}")
        except subprocess.TimeoutExpired:
            log.warning("LibreOffice export of %s timed out after %ss", src.name, TIMEOUT)
            reasons.append("LibreOffice: timed out")
        except Exception as e:
            log.warning("LibreOffice export of %s failed", src.name, exc_info=True)
            reasons.append(f"LibreOffice: {e}")
    app = "PowerPoint" if kind == "pptx" else "Word"
    if not office and not soffice:
        return str(errors.AppError("APO-FILE-310", "no converter installed", plain=(
            f"Neither Microsoft {app} nor LibreOffice is installed, so Apollo can't make an exact copy of the file.")))
    timed_out = any(r.endswith("timed out") for r in reasons)
    who = f"Microsoft {app}" if office else "LibreOffice"
    plain = (f"{who} took longer than {TIMEOUT // 60} minutes to copy the file." if timed_out
             else f"{who} couldn't copy the file" + (": a dialog may be open in it, or the file may be damaged." if office else "."))
    err = errors.AppError("APO-FILE-309", "; ".join(reasons)[:400], plain=plain)
    log.warning("%s: %s", err.code, err.technical)
    return str(err)


def rendered_pdf(doc: dict, convert=True) -> Path | None:
    """The cached exact PDF of an Office file, converting it now if needed (and allowed). A failure is remembered for
    this run (not retried on every view) and its reason kept in documents.render_error until `retry` or a success."""
    if doc["ext"] not in OFFICE_EXTS:
        return None
    out = renders_dir() / f"{doc['sha256']}.pdf"
    if out.exists() or not convert or doc["sha256"] in _failed:
        return out if out.exists() else None
    from .pipeline import doc_path
    with _lock:  # one Office conversion at a time
        if not out.exists():
            part = out.with_suffix(".part.pdf")
            error = export_pdf(doc_path(doc), part, doc["ext"][1:])
            if error is None and part.exists():
                part.replace(out)
            else:
                part.unlink(missing_ok=True)
                _failed.add(doc["sha256"])
                if doc.get("id") is not None:  # every copy of the same file shares the render
                    db.ex("UPDATE documents SET render_error=?, updated_at=? WHERE sha256=? AND ext=?",
                          (error or "Apollo couldn't make an exact copy of this file. [APO-FILE-309]", time.time(),
                           doc["sha256"], doc["ext"]))
    if out.exists() and doc.get("render_error"):
        db.ex("UPDATE documents SET render_error=NULL, updated_at=? WHERE sha256=?", (time.time(), doc["sha256"]))
    return out if out.exists() else None


def retry(doc: dict) -> Path | None:
    """Try again (the viewer's or Maintenance's button): forget this run's failure and convert now."""
    _failed.discard(doc["sha256"])
    db.ex("UPDATE documents SET render_error=NULL WHERE sha256=?", (doc["sha256"],))
    return rendered_pdf({**doc, "render_error": None})


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
    out, page_i = {}, 0
    with pymupdf.open(pdf_path) as pdf:
        pages = [_norm(p.get_text()) for p in pdf]
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
