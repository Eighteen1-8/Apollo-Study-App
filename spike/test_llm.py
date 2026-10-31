"""Phase 0: check the ninfer (OpenAI-compatible) endpoint: chat, thinking control, streaming, vision, JSON schema.
Requests are strictly sequential (server runs at concurrency 1)."""
import base64
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

HERE = Path(__file__).parent
load_dotenv(HERE.parent / ".env")
BASE = os.environ["LLM_BASE_URL"].rstrip("/")
MODEL = os.environ["LLM_MODEL"]
KEY = os.environ.get("LLM_API_KEY", "")
client = httpx.Client(headers={"Authorization": f"Bearer {KEY}"} if KEY else {}, timeout=1800)


def chat(messages, **kw):
    t = time.perf_counter()
    r = client.post(f"{BASE}/chat/completions", json={"model": MODEL, "messages": messages, **kw})
    dt = time.perf_counter() - t
    if r.status_code != 200:
        return None, dt, f"HTTP {r.status_code}: {r.text[:300]}"
    return r.json(), dt, None


def show(name, res, dt, err):
    if err:
        print(f"[{name}] FAIL {err}")
        return
    m = res["choices"][0]["message"]
    u = res.get("usage", {})
    reasoning = m.get("reasoning_content") or m.get("reasoning") or ""
    print(f"[{name}] {dt:.1f}s  prompt={u.get('prompt_tokens')} completion={u.get('completion_tokens')} "
          f"reasoning_chars={len(reasoning)}  finish={res['choices'][0].get('finish_reason')}")
    print("   ->", (m.get("content") or "").strip().replace("\n", " ")[:220])


def stream_test():
    t0 = time.perf_counter()
    first = None
    n = 0
    usage = None
    with client.stream("POST", f"{BASE}/chat/completions", json={
        "model": MODEL, "stream": True, "max_tokens": 400, "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
        "messages": [{"role": "user", "content": "Explain Newton's three laws in about 200 words."}]}) as r:
        for line in r.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            ev = json.loads(line[6:])
            usage = ev.get("usage") or usage
            if ev.get("choices") and ev["choices"][0]["delta"].get("content"):
                first = first or time.perf_counter()
                n += 1
    end = time.perf_counter()
    toks = (usage or {}).get("completion_tokens", n)
    print(f"[stream] TTFT={first - t0:.2f}s  {toks} tokens in {end - first:.1f}s -> {toks / (end - first):.1f} tok/s")


def vision_test():
    png = HERE / "out" / "kinematics_slide2.png"
    b64 = base64.b64encode(png.read_bytes()).decode()
    res, dt, err = chat([{"role": "user", "content": [
        {"type": "text", "text": "This is a lecture slide. Describe the two graphs: axes, shape, and what each implies physically. "
                                 "If an image is purely decorative, say IRRELEVANT for it."},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}]}],
        max_tokens=500, chat_template_kwargs={"enable_thinking": False})
    show("vision", res, dt, err)


FLASHCARD_SCHEMA = {
    "type": "object",
    "properties": {"cards": {"type": "array", "minItems": 3, "maxItems": 3, "items": {
        "type": "object",
        "properties": {"front": {"type": "string"}, "back": {"type": "string"},
                       "source": {"type": "string", "enum": ["S1", "S2"]}},
        "required": ["front", "back", "source"], "additionalProperties": False}}},
    "required": ["cards"], "additionalProperties": False,
}


def json_test():
    src = ("[S1] Velocity is the rate of change of displacement; it is a vector measured in m/s.\n"
           "[S2] Ohm's law: V = IR, relating voltage, current and resistance.")
    res, dt, err = chat([
        {"role": "system", "content": "You create flashcards strictly from the given sources. Cite the source id."},
        {"role": "user", "content": f"Sources:\n{src}\n\nCreate 3 flashcards."}],
        max_tokens=800, chat_template_kwargs={"enable_thinking": False},
        response_format={"type": "json_schema", "json_schema": {"name": "flashcards", "strict": True, "schema": FLASHCARD_SCHEMA}})
    show("json_schema", res, dt, err)
    if res:
        try:
            cards = json.loads(res["choices"][0]["message"]["content"])["cards"]
            ok = len(cards) == 3 and all(set(c) == {"front", "back", "source"} and c["source"] in ("S1", "S2") for c in cards)
            print(f"   schema valid: {ok}")
        except Exception as e:
            print(f"   schema valid: False ({e})")


def main():
    print("models:", client.get(f"{BASE}/models").json())
    q = [{"role": "user", "content": "In one sentence: what is the SI unit of acceleration?"}]
    show("thinking-default", *chat(q, max_tokens=2000))
    show("thinking-off", *chat(q, max_tokens=200, chat_template_kwargs={"enable_thinking": False}))
    stream_test()
    vision_test()
    json_test()


if __name__ == "__main__":
    main()
