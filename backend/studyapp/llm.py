"""Clients for the local OpenAI-compatible servers (ninfer for Qwen, LM Studio for embeddings).

All Qwen requests go through one semaphore sized by `llm_concurrency` (default 1), so the server never
sees more simultaneous requests than it can handle."""
import base64
import json
import re
import threading
import time

import httpx
import numpy as np
from pydantic import ValidationError

from . import db

_llm_gate = threading.Semaphore(1)
_gate_size = 1


def _gate():
    global _llm_gate, _gate_size
    n = max(1, int(db.setting("llm_concurrency") or 1))
    if n != _gate_size:
        _llm_gate, _gate_size = threading.Semaphore(n), n
    return _llm_gate


def _client(base_key: str, key_key: str, timeout=1800):
    key = db.setting(key_key)
    return httpx.Client(base_url=db.setting(base_key).rstrip("/"), timeout=timeout,
                        headers={"Authorization": f"Bearer {key}"} if key else {})


def reasoning_fields(reasoning) -> dict:
    """'off' (or False/None) disables thinking; otherwise a Qwen reasoning effort: low | medium | xhigh.
    ninfer passes `reasoning_effort` into the chat template, which rejects any other value."""
    if reasoning in (None, False, "off", ""):
        return {"chat_template_kwargs": {"enable_thinking": False}}
    level = reasoning if isinstance(reasoning, str) else "xhigh"
    return {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": level}


def chat(messages, max_tokens=4096, reasoning="off", temperature=None) -> dict:
    body = {"model": db.setting("llm_model"), "messages": messages, "max_tokens": max_tokens, **reasoning_fields(reasoning)}
    if temperature is not None:
        body["temperature"] = temperature
    with _gate(), _client("llm_base_url", "llm_api_key") as c:
        r = c.post("/chat/completions", json=body)
    r.raise_for_status()
    data = r.json()
    msg = data["choices"][0]["message"]
    return {"content": (msg.get("content") or "").strip(), "finish": data["choices"][0].get("finish_reason"),
            "usage": data.get("usage", {})}


def image_part(png: bytes, mime="image/png") -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(png).decode()}"}}


def chat_stream(messages, tools=None, max_tokens=8000, reasoning="off"):
    """Yields ("reasoning", text) / ("content", text) deltas, then ("tool_calls", [{id, name, arguments}]) if any,
    then ("done", finish_reason). Holds the concurrency gate for the whole stream."""
    body = {"model": db.setting("llm_model"), "messages": messages, "max_tokens": max_tokens, "stream": True,
            **reasoning_fields(reasoning)}
    if tools:
        body["tools"] = tools
    calls: dict[int, dict] = {}
    finish = None
    with _gate(), _client("llm_base_url", "llm_api_key") as c, c.stream("POST", "/chat/completions", json=body) as r:
        if r.status_code != 200:
            raise RuntimeError(f"LLM HTTP {r.status_code}: {r.read()[:300]!r}")
        for line in r.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            ev = json.loads(line[6:])
            if not ev.get("choices"):
                continue
            ch = ev["choices"][0]
            d = ch.get("delta") or {}
            if d.get("reasoning_content") or d.get("reasoning"):
                yield "reasoning", d.get("reasoning_content") or d.get("reasoning")
            if d.get("content"):
                yield "content", d["content"]
            for tc in d.get("tool_calls") or []:
                slot = calls.setdefault(tc.get("index", 0), {"id": None, "name": "", "arguments": ""})
                slot["id"] = slot["id"] or tc.get("id")
                fn = tc.get("function") or {}
                slot["name"] += fn.get("name") or ""
                slot["arguments"] += fn.get("arguments") or ""
            finish = ch.get("finish_reason") or finish
    if calls:
        out = []
        for slot in calls.values():
            try:
                args = json.loads(slot["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            out.append({"id": slot["id"], "name": slot["name"], "arguments": args})
        yield "tool_calls", out
    yield "done", finish


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _extract_json(text):
    m = _FENCE.search(text)
    text = m.group(1) if m else text
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError("no JSON found")
    return json.loads(text[min(starts):max(text.rfind("}"), text.rfind("]")) + 1])


def chat_json(messages, model, retries=2, **kw):
    """Structured output without server-side constrained decoding (ninfer rejects json_schema):
    the schema goes at the end of the last user message, the reply is parsed + validated, invalid replies are repaired."""
    schema = json.dumps(model.model_json_schema())
    msgs = [dict(m) for m in messages]
    tail = f"\n\nRespond with ONLY a JSON object matching this JSON Schema (no prose, no code fences):\n{schema}"
    last = msgs[-1]
    last["content"] = (last["content"] + tail) if isinstance(last["content"], str) else [*last["content"], {"type": "text", "text": tail}]
    err = None
    for _ in range(retries + 1):
        res = chat(msgs, **kw)
        try:
            return model.model_validate(_extract_json(res["content"]))
        except (ValueError, ValidationError) as e:
            err = e
            msgs += [{"role": "assistant", "content": res["content"]},
                     {"role": "user", "content": f"That was invalid ({str(e)[:400]}). Return ONLY the corrected JSON."}]
    raise RuntimeError(f"Model did not return valid JSON: {err}")


QUERY_INSTRUCT = "Instruct:Given a student's question, retrieve study material passages that answer it\nQuery: "


def embed(texts: list[str], query=False) -> np.ndarray:
    if query:
        texts = [QUERY_INSTRUCT + t for t in texts]
    with _client("embed_base_url", "embed_api_key", timeout=600) as c:
        r = c.post("/embeddings", json={"model": db.setting("embed_model"), "input": texts})
    r.raise_for_status()
    data = sorted(r.json()["data"], key=lambda d: d["index"])
    v = np.array([d["embedding"] for d in data], dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def test_connections() -> dict:
    out = {}
    t = time.perf_counter()
    try:
        with _client("llm_base_url", "llm_api_key", timeout=10) as c:
            models = c.get("/models").json().get("data", [])
        want = db.setting("llm_model")
        m = next((m for m in models if m["id"] == want), None)
        out["llm"] = {"ok": m is not None, "models": [m["id"] for m in models],
                      "max_model_len": (m or {}).get("max_model_len"), "ms": round((time.perf_counter() - t) * 1000),
                      "error": None if m else f"model '{want}' not found on server"}
    except Exception as e:
        out["llm"] = {"ok": False, "error": str(e)}
    t = time.perf_counter()
    try:
        v = embed(["connection test"])
        out["embed"] = {"ok": True, "dim": int(v.shape[1]), "ms": round((time.perf_counter() - t) * 1000)}
    except Exception as e:
        out["embed"] = {"ok": False, "error": str(e)}
    return out
