"""Phase 0: ninfer prefill/decode speed with real topic material at ~30k and ~60k tokens."""
import json
import time
from pathlib import Path

from test_llm import BASE, MODEL, client

OUT = Path(__file__).parent / "out"
SKIP = "Question Book"  # practice exam is not topic material


def material():
    parts = []
    for f in sorted(OUT.glob("*.units.json")):
        if SKIP in f.name or f.stem.startswith(("kinematics", "circuits", "textbook_ch2")):
            continue
        for u in json.loads(f.read_text(encoding="utf-8")):
            parts.append(f"[{f.stem.removesuffix('.units')} {u['type']} {u.get('index', '')}]\n{u['text']}")
    return "\n\n".join(parts)


def run(label, text, max_tokens=300):
    t0 = time.perf_counter()
    first = None
    usage = {}
    with client.stream("POST", f"{BASE}/chat/completions", json={
        "model": MODEL, "stream": True, "max_tokens": max_tokens, "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "system", "content": "You are a study assistant. Use only the provided material."},
                     {"role": "user", "content": f"MATERIAL:\n{text}\n\nList the 8 main topics this material covers, one line each."}]}) as r:
        if r.status_code != 200:
            print(label, "HTTP", r.status_code, r.read()[:300])
            return
        for line in r.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            ev = json.loads(line[6:])
            usage = ev.get("usage") or usage
            if ev.get("choices") and ev["choices"][0]["delta"].get("content") and first is None:
                first = time.perf_counter()
    end = time.perf_counter()
    p, c = usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)
    print(f"[{label}] prompt={p:,} tok  prefill(TTFT)={first - t0:.1f}s -> {p / (first - t0):,.0f} tok/s  "
          f"decode={c} tok in {end - first:.1f}s -> {c / (end - first):.0f} tok/s")


if __name__ == "__main__":
    m = material()
    run("~30k real", m)
    run("~60k (material x2)", m + "\n\n" + m)
    run("~30k again (prefix cache?)", m)
