"""Clients for the OpenAI-compatible model servers: local (ninfer for Qwen, LM Studio for embeddings) or, when the
user opts in, OpenRouter. `llm_cfg()` / `embed_cfg()` resolve which one is in use; callers never read the
provider-specific settings themselves.

All chat requests go through one semaphore sized by the active provider's concurrency (default 1), so the server
never sees more simultaneous requests than it can handle."""
import base64
import contextlib
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


def llm_cfg() -> dict:
    """The language model in use: the local server, or OpenRouter when `llm_provider` is "openrouter"."""
    s = db.setting
    if s("llm_provider") == "openrouter":
        return {"base_url": s("openrouter_base_url"), "api_key": s("openrouter_api_key"), "model": s("openrouter_model"),
                "context": int(s("openrouter_context")), "concurrency": int(s("openrouter_concurrency") or 1), "online": True}
    return {"base_url": s("llm_base_url"), "api_key": s("llm_api_key"), "model": s("llm_model"),
            "context": int(s("llm_context")), "concurrency": int(s("llm_concurrency") or 1), "online": False}


def embed_cfg() -> dict:
    s = db.setting
    if s("embed_provider") == "openrouter":
        return {"base_url": s("openrouter_base_url"), "api_key": s("openrouter_api_key"), "model": s("openrouter_embed_model"), "online": True}
    return {"base_url": s("embed_base_url"), "api_key": s("embed_api_key"), "model": s("embed_model"), "online": False}


def context_tokens() -> int:
    return llm_cfg()["context"]


def embed_model() -> str:
    """The embedding model new vectors are made with (and that search and staleness compare against)."""
    return embed_cfg()["model"]


def _gate():
    global _llm_gate, _gate_size
    n = max(1, llm_cfg()["concurrency"])
    if n != _gate_size:
        _llm_gate, _gate_size = threading.Semaphore(n), n
    return _llm_gate


def _client(cfg: dict, timeout=1800):
    headers = {"Authorization": f"Bearer {cfg['api_key']}"} if cfg["api_key"] else {}
    if cfg["online"]:
        headers["X-Title"] = "Apollo Study"
    return httpx.Client(base_url=cfg["base_url"].rstrip("/"), timeout=timeout, headers=headers)


RETRY_STATUS = (429, 502, 503)
RETRIES = 5  # waits 2, 4, 8, 16, 30 s: free models are often briefly rate limited upstream


def _retry_wait(r, attempt: int) -> float:
    return min(30.0, float(r.headers.get("retry-after") or 2 * 2 ** attempt))


def _post(cfg: dict, path: str, body: dict, timeout=1800) -> dict:
    """POST with a few backoff retries on rate limits / overload (free online models hit these often)."""
    for attempt in range(RETRIES + 1):
        with _client(cfg, timeout) as c:
            r = c.post(path, json=body)
        if r.status_code in RETRY_STATUS and attempt < RETRIES:
            time.sleep(_retry_wait(r, attempt))
            continue
        if r.status_code != 200:
            raise RuntimeError(f"{'OpenRouter' if cfg['online'] else 'Model server'} HTTP {r.status_code}: {r.text[:300]}")
        data = r.json()
        if data.get("error"):  # OpenRouter can report upstream failures inside a 200
            raise RuntimeError(f"OpenRouter: {data['error'].get('message', data['error'])}")
        return data
    raise RuntimeError("unreachable")


@contextlib.contextmanager
def _stream(cfg: dict, body: dict):
    """An open streaming chat response, with the same retries as _post (only before any data has arrived)."""
    for attempt in range(RETRIES + 1):
        with _client(cfg) as c, c.stream("POST", "/chat/completions", json=body) as r:
            if r.status_code == 200:
                yield r
                return
            r.read()
            if r.status_code not in RETRY_STATUS or attempt == RETRIES:
                raise RuntimeError(f"{'OpenRouter' if cfg['online'] else 'LLM'} HTTP {r.status_code}: {r.text[:300]}")
            wait = _retry_wait(r, attempt)
        time.sleep(wait)


def reasoning_fields(reasoning, online=False) -> dict:
    """'off' (or False/None) disables thinking; otherwise a Qwen reasoning effort: low | medium | xhigh.
    ninfer passes `reasoning_effort` into the chat template, which rejects any other value. OpenRouter takes
    `reasoning.effort` (low | medium | high), so xhigh maps to high."""
    if online:
        if reasoning in (None, False, "off", ""):
            return {"reasoning": {"enabled": False}}
        return {"reasoning": {"effort": reasoning if reasoning in ("low", "medium") else "high"}}
    if reasoning in (None, False, "off", ""):
        return {"chat_template_kwargs": {"enable_thinking": False}}
    level = reasoning if isinstance(reasoning, str) else "xhigh"
    return {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": level}


def chat(messages, max_tokens=4096, reasoning="off", temperature=None) -> dict:
    cfg = llm_cfg()
    body = {"model": cfg["model"], "messages": messages, "max_tokens": max_tokens, **reasoning_fields(reasoning, cfg["online"])}
    if temperature is not None:
        body["temperature"] = temperature
    with _gate():
        data = _post(cfg, "/chat/completions", body)
    msg = data["choices"][0]["message"]
    return {"content": (msg.get("content") or "").strip(), "finish": data["choices"][0].get("finish_reason"),
            "usage": data.get("usage", {})}


def image_part(png: bytes, mime="image/png") -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(png).decode()}"}}


def chat_stream(messages, tools=None, max_tokens=8000, reasoning="off"):
    """Yields ("reasoning", text) / ("content", text) deltas, then ("tool_calls", [{id, name, arguments}]) if any,
    then ("done", finish_reason). Holds the concurrency gate for the whole stream."""
    cfg = llm_cfg()
    body = {"model": cfg["model"], "messages": messages, "max_tokens": max_tokens, "stream": True,
            **reasoning_fields(reasoning, cfg["online"])}
    if tools:
        body["tools"] = tools
    calls: dict[int, dict] = {}
    finish = None
    with _gate(), _stream(cfg, body) as r:
        for line in r.iter_lines():
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue  # (also skips OpenRouter's ": OPENROUTER PROCESSING" keep-alive comments)
            ev = json.loads(line[6:])
            if ev.get("error"):
                raise RuntimeError(f"OpenRouter: {ev['error'].get('message', ev['error'])}")
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
    cfg = embed_cfg()
    if query and "qwen3" in cfg["model"].lower():  # the instruction prefix is specific to Qwen3 embedding models
        texts = [QUERY_INSTRUCT + t for t in texts]
    data = sorted(_post(cfg, "/embeddings", {"model": cfg["model"], "input": texts}, timeout=600)["data"], key=lambda d: d["index"])
    v = np.array([d["embedding"] for d in data], dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def test_connections() -> dict:
    out = {}
    t = time.perf_counter()
    cfg = llm_cfg()
    try:
        with _client(cfg, timeout=15) as c:
            models = c.get("/models").json().get("data", [])
        want = cfg["model"]
        m = next((m for m in models if m["id"] == want), None)
        if m and cfg["online"]:  # listing models needs no key, so make one tiny call to catch a bad key here
            chat([{"role": "user", "content": "Reply with OK."}], max_tokens=16)
        out["llm"] = {"ok": m is not None, "online": cfg["online"], "model": want, "models": [m["id"] for m in models][:200],
                      "max_model_len": (m or {}).get("max_model_len") or (m or {}).get("context_length"),
                      "ms": round((time.perf_counter() - t) * 1000), "error": None if m else f"model '{want}' not found on server"}
    except Exception as e:
        out["llm"] = {"ok": False, "error": str(e)}
    t = time.perf_counter()
    try:
        v = embed(["connection test"])
        out["embed"] = {"ok": True, "online": embed_cfg()["online"], "model": embed_model(), "dim": int(v.shape[1]), "ms": round((time.perf_counter() - t) * 1000)}
    except Exception as e:
        out["embed"] = {"ok": False, "error": str(e)}
    return out
