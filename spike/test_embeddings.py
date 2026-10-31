"""Phase 0: check the LM Studio embedding endpoint (connectivity, dimension, throughput, quality)."""
import os
import time

import httpx
import numpy as np
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
BASE = os.environ["EMBED_BASE_URL"].rstrip("/")
KEY = os.environ.get("EMBED_API_KEY", "")
MODEL = os.environ["EMBED_MODEL"]
client = httpx.Client(headers={"Authorization": f"Bearer {KEY}"}, timeout=600)

# Qwen3-Embedding is instruction-aware: queries get an instruction prefix, documents don't.
QUERY_INSTRUCT = "Instruct: Given a student's question, retrieve study material passages that answer it\nQuery: "


def embed(texts):
    r = client.post(f"{BASE}/embeddings", json={"model": MODEL, "input": texts})
    r.raise_for_status()
    data = sorted(r.json()["data"], key=lambda d: d["index"])
    v = np.array([d["embedding"] for d in data], dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def main():
    models = client.get(f"{BASE}/models").json()
    print("models:", [m["id"] for m in models.get("data", [])])

    passages = [
        "Velocity is the rate of change of displacement with respect to time. It is a vector quantity measured in m/s.",
        "Newton's second law states that the net force on an object equals its mass multiplied by its acceleration, F = ma.",
        "A MOSFET is a voltage-controlled transistor; the gate voltage controls current flow between drain and source.",
        "Ohm's law relates voltage, current and resistance: V = IR.",
        "Projectile motion can be split into independent horizontal (constant velocity) and vertical (constant acceleration g) components.",
        "A stepper motor rotates in discrete steps and is commonly driven by an H-bridge in mechatronic systems.",
    ]
    queries = [
        ("how do I find the horizontal distance a ball travels when thrown", 4),
        ("what controls the current in a field effect transistor", 2),
        ("relationship between force and acceleration", 1),
    ]

    t = time.perf_counter()
    P = embed(passages)
    print(f"dim={P.shape[1]}  first batch ({len(passages)} short) {time.perf_counter() - t:.2f}s")

    hits = 0
    for q, expected in queries:
        s = P @ embed([QUERY_INSTRUCT + q])[0]
        best = int(s.argmax())
        hits += best == expected
        print(f"  {'OK ' if best == expected else 'MISS'} q={q!r} -> #{best} ({s[best]:.3f}, next {np.sort(s)[-2]:.3f})")
    print(f"retrieval sanity: {hits}/{len(queries)}")

    # Throughput on realistic chunk sizes (~500 tokens ≈ 2000 chars).
    chunk = (" ".join(passages) + " ") * 4
    chunk = chunk[:2000]
    for batch in (1, 8, 16):
        t = time.perf_counter()
        embed([chunk] * batch)
        dt = time.perf_counter() - t
        print(f"batch={batch:>2} x ~500 tok: {dt:.2f}s  -> {batch / dt:.2f} chunks/s")


if __name__ == "__main__":
    main()
