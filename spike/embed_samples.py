"""Phase 0: chunk parsed units (structure-aware, ~600 tokens) and embed them; print stats + a retrieval smoke test."""
import json
import time
from pathlib import Path

import numpy as np
import tiktoken

from test_embeddings import QUERY_INSTRUCT, embed

OUT = Path(__file__).parent / "out"
enc = tiktoken.get_encoding("cl100k_base")
TARGET, MAX = 600, 900


def chunk_units(doc, units):
    chunks, buf, start = [], [], None
    def flush():
        nonlocal buf, start
        if buf:
            chunks.append({"doc": doc, "units": f"{start}-{buf[-1][0]}", "text": "\n".join(t for _, t in buf)})
        buf, start = [], None
    for u in units:
        text = (u.get("heading", "") + "\n" + u["text"] + ("\nNotes: " + u["notes"] if u.get("notes") else "")).strip()
        if len(text.split()) < 3:
            continue
        idx = u.get("index", u.get("heading", "?"))
        toks = enc.encode(text)
        if len(toks) > MAX:  # long unit (e.g. a docx section): split by tokens with overlap
            flush()
            for i in range(0, len(toks), TARGET - 80):
                chunks.append({"doc": doc, "units": f"{idx}", "text": enc.decode(toks[i:i + TARGET])})
            continue
        if sum(len(enc.encode(t)) for _, t in buf) + len(toks) > TARGET:
            flush()
        start = idx if start is None else start
        buf.append((idx, text))
    flush()
    return chunks


def main():
    chunks = []
    for f in sorted(OUT.glob("*.units.json")):
        if "Question Book" in f.name or f.stem.startswith(("kinematics", "circuits", "textbook_ch2")):
            continue
        chunks += chunk_units(f.stem.removesuffix(".units"), json.loads(f.read_text(encoding="utf-8")))
    sizes = [len(enc.encode(c["text"])) for c in chunks]
    print(f"{len(chunks)} chunks, tokens avg={np.mean(sizes):.0f} min={min(sizes)} max={max(sizes)}")
    t = time.perf_counter()
    vecs = np.vstack([embed([c["text"] for c in chunks[i:i + 16]]) for i in range(0, len(chunks), 16)])
    dt = time.perf_counter() - t
    print(f"embedded in {dt:.1f}s -> {len(chunks) / dt:.1f} chunks/s, {sum(sizes) / dt:,.0f} tok/s")
    np.save(OUT / "_vecs.npy", vecs)
    (OUT / "_chunks.json").write_text(json.dumps(chunks), encoding="utf-8")

    for q in ["total internal reflection and critical angle in optical fibres",
              "how do resistors in parallel combine",
              "conservation of energy in an electrical circuit loop",
              "diffraction of light through a slit"]:
        s = vecs @ embed([QUERY_INSTRUCT + q])[0]
        top = np.argsort(-s)[:3]
        print(f"Q: {q}\n   " + "\n   ".join(f"{s[i]:.3f}  {chunks[i]['doc']} [{chunks[i]['units']}]" for i in top))


if __name__ == "__main__":
    main()
