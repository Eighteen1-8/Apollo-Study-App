"""Structure-aware chunking of a document's (non-duplicate) units. Only real extracted text is chunked;
vision notes stay on the units and are looked up by unit range at generation time."""
import re

from .parsers import approx_tokens


def _split_long(text: str, target: int) -> list[str]:
    """Split on paragraph, then sentence boundaries, keeping pieces near `target` tokens."""
    pieces, cur = [], ""
    for para in re.split(r"\n(?=\S)", text):
        sentences = re.split(r"(?<=[.!?])\s+", para) if approx_tokens(para) > target else [para]
        for sent in sentences:
            if cur and approx_tokens(cur + "\n" + sent) > target:
                pieces.append(cur)
                cur = sent
            else:
                cur = f"{cur}\n{sent}" if cur else sent
    if cur:
        pieces.append(cur)
    return pieces


def chunk_units(units: list[dict], target: int, max_slides: int) -> list[dict]:
    """units: dicts with idx, kind, label, text (duplicates already removed). Returns chunk dicts."""
    chunks, buf = [], []

    def flush():
        if buf:
            label = buf[0]["label"] if len(buf) == 1 else f"{buf[0]['label'].split(' · ')[0]} – {buf[-1]['label'].split(' · ')[0]}"
            chunks.append({"unit_start": buf[0]["idx"], "unit_end": buf[-1]["idx"], "label": label,
                           "text": "\n\n".join(f"[{u['label']}]\n{u['text']}" for u in buf)})
            buf.clear()

    for u in units:
        if not u["text"].strip():
            continue
        if approx_tokens(u["text"]) > target * 1.5:
            flush()
            for k, piece in enumerate(_split_long(u["text"], target), 1):
                chunks.append({"unit_start": u["idx"], "unit_end": u["idx"], "label": f"{u['label']} (part {k})",
                               "text": f"[{u['label']}]\n{piece}"})
            continue
        size = sum(approx_tokens(b["text"]) for b in buf) + approx_tokens(u["text"])
        if buf and (size > target or (u["kind"] == "slide" and len(buf) >= max_slides) or u["kind"] == "section"):
            flush()
        buf.append(u)
    flush()
    for c in chunks:
        c["token_count"] = approx_tokens(c["text"])
    return chunks
