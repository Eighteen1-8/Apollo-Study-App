"""Clients for the OpenAI-compatible model servers: local (ninfer for Qwen, LM Studio for embeddings) or, when the
user opts in, OpenRouter. `llm_cfg()` / `embed_cfg()` resolve which one is in use; callers never read the
provider-specific settings themselves.

All chat requests go through one semaphore sized by the active provider's concurrency (default 1), so the server
never sees more simultaneous requests than it can handle.

The language model and the embedding model can each be paused (settings `pause_llm` / `pause_embed`, e.g. to unload
Qwen and free VRAM). A background job reaching a paused model waits in place (its worker installs a wait hook);
anything interactive, like chat, gets `Paused` straight away."""
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
_local = threading.local()


class Paused(RuntimeError):
    pass


PAUSE_NAMES = {"llm": "The language model", "embed": "The embedding model"}


def paused(kind: str) -> bool:
    """kind: "llm" | "embed"."""
    return bool(db.setting(f"pause_{kind}"))


def set_wait_hook(fn):
    """Installed by a job worker for its thread: fn(kind) blocks while that model is paused."""
    _local.wait_hook = fn


def _wait_if_paused(kind: str):
    if not paused(kind):
        return
    hook = getattr(_local, "wait_hook", None)
    if hook is None:
        raise Paused(f"{PAUSE_NAMES[kind]} is paused. Resume it from the background jobs panel to continue.")
    hook(kind)


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


def _retryable(r) -> bool:
    """Brief rate limits and overloads are retried; a used-up daily allowance ("free-models-per-day") is not."""
    return r.status_code in RETRY_STATUS and "per-day" not in r.text


_GONE = re.compile(r"not a valid model|no endpoints found|model .{0,80}(not found|does not exist|is not available)", re.I)


def _raise_model_gone(cfg: dict, body: dict, r):
    """OpenRouter retires models (free ones especially) without notice: say so plainly, not as an HTTP error."""
    if cfg["online"] and r.status_code in (400, 404) and _GONE.search(r.text):
        kind = "embedding" if "input" in body and "messages" not in body else "chat"
        raise RuntimeError(f"The OpenRouter {kind} model '{body.get('model')}' isn't offered any more. "
                           "Pick another in Settings → Model provider.")


def _post(cfg: dict, path: str, body: dict, timeout=1800) -> dict:
    """POST with a few backoff retries on rate limits / overload (free online models hit these often)."""
    for attempt in range(RETRIES + 1):
        with _client(cfg, timeout) as c:
            r = c.post(path, json=body)
        if _retryable(r) and attempt < RETRIES:
            time.sleep(_retry_wait(r, attempt))
            continue
        if r.status_code != 200:
            _raise_model_gone(cfg, body, r)
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
            _raise_model_gone(cfg, body, r)
            if not _retryable(r) or attempt == RETRIES:
                raise RuntimeError(f"{'OpenRouter' if cfg['online'] else 'LLM'} HTTP {r.status_code}: {r.text[:300]}")
            wait = _retry_wait(r, attempt)
        time.sleep(wait)


# ---------------------------------------------------------------- the local server's profile
# What the local model server accepts, kept as a setting (`server_profile`) instead of being assumed in code, so a new
# ninfer or model release that changes one of them is fixed by Settings → Test connections (probe_server), not a
# code change. The defaults are what ninfer with Qwen3.8 accepts (measured 2026-11).
DEFAULT_PROFILE = {
    # how thinking is switched: "template" = chat_template_kwargs.enable_thinking, "none" = no switch
    "thinking_switch": "template",
    # the request field carrying the reasoning level ("" = none), and the levels the server accepts
    "reasoning_param": "reasoning_effort",
    "reasoning_levels": ["low", "medium", "xhigh"],
    # response_format json_schema (ninfer rejects it: chat_json puts the schema in the prompt instead)
    "json_schema": False,
    # stream_options.include_usage (token counts at the end of a stream)
    "stream_usage": True,
    # native tool calls
    "tools": True,
}


def profile() -> dict:
    """The local server's profile (OpenRouter has its own fixed API, see reasoning_fields)."""
    saved = db.setting("server_profile")
    return {**DEFAULT_PROFILE, **(saved if isinstance(saved, dict) else {})}


def _level(reasoning, levels: list[str]) -> str:
    """The server's level nearest to the one asked for (xhigh on a server whose top is "high" uses "high")."""
    order = ["low", "medium", "high", "xhigh"]
    want = reasoning if isinstance(reasoning, str) else "xhigh"
    if want in levels or not levels:
        return want
    rank = order.index(want) if want in order else len(order) - 1
    known = [lv for lv in levels if lv in order] or levels
    return min(known, key=lambda lv: abs((order.index(lv) if lv in order else rank) - rank))


def reasoning_fields(reasoning, online=False) -> dict:
    """'off' (or False/None) disables thinking; otherwise a reasoning level. The local server is told the way its
    profile says (ninfer: `reasoning_effort` in low | medium | xhigh, and chat_template_kwargs.enable_thinking; its
    chat template rejects any other level). OpenRouter takes `reasoning.effort` (low | medium | high), so xhigh maps
    to high."""
    if online:
        if reasoning in (None, False, "off", ""):
            return {"reasoning": {"enabled": False}}
        return {"reasoning": {"effort": reasoning if reasoning in ("low", "medium") else "high"}}
    prof = profile()
    switch = prof["thinking_switch"] == "template"
    if reasoning in (None, False, "off", ""):
        return {"chat_template_kwargs": {"enable_thinking": False}} if switch else {}
    out = {"chat_template_kwargs": {"enable_thinking": True}} if switch else {}
    if prof["reasoning_param"]:
        out[prof["reasoning_param"]] = _level(reasoning, prof["reasoning_levels"])
    return out


def strip_think(text: str) -> str:
    """A reply without the model's reasoning: closed <think> blocks, a reply whose opening tag was in the chat template
    (only </think> appears), and an unclosed block where the reply ran out mid-thought."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S)
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1]
    return text.split("<think>", 1)[0].strip()


def chat(messages, max_tokens=4096, reasoning="off", temperature=None, response_format=None) -> dict:
    cfg = llm_cfg()
    body = {"model": cfg["model"], "messages": messages, "max_tokens": max_tokens, **reasoning_fields(reasoning, cfg["online"])}
    if temperature is not None:
        body["temperature"] = temperature
    if response_format is not None:
        body["response_format"] = response_format
    _wait_if_paused("llm")
    with _gate():
        data = _post(cfg, "/chat/completions", body)
    msg = data["choices"][0]["message"]
    return {"content": (msg.get("content") or "").strip(), "finish": data["choices"][0].get("finish_reason"),
            "usage": data.get("usage", {})}


def image_part(png: bytes, mime="image/png") -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(png).decode()}"}}


class StreamCancelled(Exception):
    """chat_stream's `cancelled` callable said stop (the stream was closed, even mid-prefill)."""


def _watch_cancel(r, cancelled, done: threading.Event):
    """Close the open response as soon as `cancelled()` is true, so a stop doesn't wait for the next token (a long
    prompt can take a minute before the first one)."""
    while not done.wait(0.3):
        try:
            if cancelled():
                r.close()
                return
        except Exception:
            return


def chat_stream(messages, tools=None, max_tokens=8000, reasoning="off", cancelled=None):
    """Yields ("reasoning", text) / ("content", text) deltas, then ("tool_calls", [{id, name, arguments}]) if any,
    then ("usage", {prompt, completion, reasoning, cost}) when the server reports it, then ("done", finish_reason).
    Holds the concurrency gate for the whole stream. `cancelled`: a callable checked in the background; when it
    turns true the response is closed and StreamCancelled raised."""
    cfg = llm_cfg()
    prof = None if cfg["online"] else profile()
    body = {"model": cfg["model"], "messages": messages, "max_tokens": max_tokens, "stream": True,
            **reasoning_fields(reasoning, cfg["online"])}
    if cfg["online"] or prof["stream_usage"]:
        body["stream_options"] = {"include_usage": True}
    if cfg["online"]:
        body["usage"] = {"include": True}  # OpenRouter: adds the cost
    if tools and (cfg["online"] or prof["tools"]):
        body["tools"] = tools
    calls: dict[int, dict] = {}
    finish = None
    usage = None
    _wait_if_paused("llm")
    with _gate(), _stream(cfg, body) as r:
        done = threading.Event()
        if cancelled:
            threading.Thread(target=_watch_cancel, args=(r, cancelled, done), daemon=True, name="stream-cancel").start()
        try:
            for line in r.iter_lines():
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue  # (also skips OpenRouter's ": OPENROUTER PROCESSING" keep-alive comments)
                ev = json.loads(line[6:])
                if ev.get("error"):
                    raise RuntimeError(f"OpenRouter: {ev['error'].get('message', ev['error'])}")
                if ev.get("usage"):
                    usage = ev["usage"]
                if not ev.get("choices"):
                    continue
                yield from _stream_event(ev, calls)
                finish = ev["choices"][0].get("finish_reason") or finish
        except Exception:
            if cancelled and cancelled():
                raise StreamCancelled() from None
            raise
        finally:
            done.set()
        if cancelled and cancelled():
            raise StreamCancelled()
    if calls:
        out = []
        for slot in calls.values():
            try:
                args = json.loads(slot["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            out.append({"id": slot["id"], "name": slot["name"], "arguments": args})
        yield "tool_calls", out
    if usage:
        details = usage.get("completion_tokens_details") or {}
        yield "usage", {"prompt": int(usage.get("prompt_tokens") or 0), "completion": int(usage.get("completion_tokens") or 0),
                        "reasoning": int(details.get("reasoning_tokens") or 0), "cost": usage.get("cost")}
    yield "done", finish


def _stream_event(ev, calls):
    """The deltas in one streamed chunk; tool-call fragments are collected into `calls`."""
    d = ev["choices"][0].get("delta") or {}
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


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _extract_json(text):
    m = _FENCE.search(text)
    text = m.group(1) if m else text
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        raise ValueError("no JSON found")
    return json.loads(text[min(starts):max(text.rfind("}"), text.rfind("]")) + 1])


def chat_json(messages, model, retries=2, **kw):
    """Structured output. The schema always goes at the end of the last user message, and the reply is parsed,
    validated and repaired if invalid. A server whose profile says it takes `json_schema` also gets it as
    response_format (constrained decoding); ninfer rejects it, so by default it isn't sent."""
    schema = json.dumps(model.model_json_schema())
    cfg = llm_cfg()
    if not cfg["online"] and profile()["json_schema"]:
        kw.setdefault("response_format", {"type": "json_schema",
                                          "json_schema": {"name": model.__name__, "schema": model.model_json_schema()}})
    msgs = [dict(m) for m in messages]
    tail = f"\n\nRespond with ONLY a JSON object matching this JSON Schema (no prose, no code fences):\n{schema}"
    last = msgs[-1]
    last["content"] = (last["content"] + tail) if isinstance(last["content"], str) else [*last["content"], {"type": "text", "text": tail}]
    err = None
    for _ in range(retries + 1):
        res = chat(msgs, **kw)
        try:
            return model.model_validate(_extract_json(strip_think(res["content"])))
        except (ValueError, ValidationError) as e:
            err = e
            msgs += [{"role": "assistant", "content": res["content"]},
                     {"role": "user", "content": f"That was invalid ({str(e)[:400]}). Return ONLY the corrected JSON."}]
    raise RuntimeError(f"Model did not return valid JSON: {err}")


QUERY_INSTRUCT = "Instruct:Given a student's question, retrieve study material passages that answer it\nQuery: "


def embed(texts: list[str], query=False) -> np.ndarray:
    _wait_if_paused("embed")
    cfg = embed_cfg()
    if query and "qwen3" in cfg["model"].lower():  # the instruction prefix is specific to Qwen3 embedding models
        texts = [QUERY_INSTRUCT + t for t in texts]
    data = sorted(_post(cfg, "/embeddings", {"model": cfg["model"], "input": texts}, timeout=600)["data"], key=lambda d: d["index"])
    v = np.array([d["embedding"] for d in data], dtype=np.float32)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def probe_server(cfg: dict | None = None) -> dict:
    """Find out what the local server accepts, one tiny request per feature (max_tokens 1-2, so a few seconds in all),
    save it as the `server_profile` setting and the reasoning levels offered in chat, and return what was found.
    A feature counts as supported when the server answers 200; ninfer answers 400/500 to what its template rejects."""
    cfg = cfg or llm_cfg()
    msgs = [{"role": "user", "content": "Reply with OK."}]

    def ok(extra: dict, stream=False) -> bool:
        body = {"model": cfg["model"], "messages": msgs, "max_tokens": 2, **extra}
        try:
            with _client(cfg, timeout=120) as c:
                if not stream:
                    return c.post("/chat/completions", json=body).status_code == 200
                with c.stream("POST", "/chat/completions", json={**body, "stream": True}) as r:
                    if r.status_code != 200:
                        return False
                    return any(line.startswith("data: ") and '"usage"' in line and '"prompt_tokens"' in line
                               for line in r.iter_lines())
        except httpx.HTTPError:
            return False

    with _gate():
        switch = "template" if ok({"chat_template_kwargs": {"enable_thinking": False}}) else "none"
        think = {"chat_template_kwargs": {"enable_thinking": True}} if switch == "template" else {}
        levels = [lv for lv in ("low", "medium", "high", "xhigh") if ok({**think, "reasoning_effort": lv})]
        # a server that ignores the field accepts every value: then it's no real switch, and none is sent
        bogus = ok({**think, "reasoning_effort": "not-a-level"})
        found = {
            "thinking_switch": switch,
            "reasoning_param": "reasoning_effort" if levels and not bogus else "",
            "reasoning_levels": levels if levels and not bogus else [],
            "json_schema": ok({"response_format": {"type": "json_schema", "json_schema": {
                "name": "Probe", "schema": {"type": "object", "properties": {"ok": {"type": "boolean"}}}}}}),
            "stream_usage": ok({"stream_options": {"include_usage": True}}, stream=True),
            "tools": ok({"tools": [{"type": "function", "function": {"name": "noop", "description": "Does nothing.",
                                                                      "parameters": {"type": "object", "properties": {}}}}]}),
        }
    db.put_settings({"server_profile": {**found, "probed_at": time.time(), "model": cfg["model"]},
                     "reasoning_levels": found["reasoning_levels"]})
    return found


def _model_list(cfg: dict) -> list[dict]:
    with _client(cfg, timeout=15) as c:
        return c.get("/models").json().get("data", [])


def openrouter_models() -> list[dict]:
    """OpenRouter's chat models, for picking one in Settings: id, name, context length and whether it's free."""
    s = db.setting
    cfg = {"base_url": s("openrouter_base_url"), "api_key": s("openrouter_api_key"), "online": True}
    out = []
    for m in _model_list(cfg):
        price = m.get("pricing") or {}
        free = m["id"].endswith(":free") or all(str(price.get(k, "1")) in ("0", "0.0") for k in ("prompt", "completion"))
        out.append({"id": m["id"], "name": m.get("name") or m["id"], "context": m.get("context_length"), "free": free,
                    "vision": "image" in ((m.get("architecture") or {}).get("input_modalities") or [])})
    return sorted(out, key=lambda m: (not m["free"], m["id"]))


def test_connections() -> dict:
    out = {}
    t = time.perf_counter()
    cfg = llm_cfg()
    try:
        models = _model_list(cfg)
        want = cfg["model"]
        m = next((m for m in models if m["id"] == want), None)
        if m and cfg["online"]:  # listing models needs no key, so make one tiny call to catch a bad key here
            _post(cfg, "/chat/completions", {"model": want, "messages": [{"role": "user", "content": "Reply with OK."}], "max_tokens": 16})
        gone = (f"The OpenRouter model '{want}' isn't offered any more. Pick another in Settings → Model provider."
                if cfg["online"] else f"model '{want}' not found on server")
        out["llm"] = {"ok": m is not None, "online": cfg["online"], "model": want, "models": [m["id"] for m in models][:200],
                      "max_model_len": (m or {}).get("max_model_len") or (m or {}).get("context_length"),
                      "ms": round((time.perf_counter() - t) * 1000), "error": None if m else gone}
        if m and not cfg["online"] and not paused("llm"):
            out["llm"]["profile"] = probe_server(cfg)
    except Exception as e:
        out["llm"] = {"ok": False, "error": str(e)}
    t = time.perf_counter()
    try:
        if paused("embed"):
            raise Paused("paused (not tested)")
        v = embed(["connection test"])
        out["embed"] = {"ok": True, "online": embed_cfg()["online"], "model": embed_model(), "dim": int(v.shape[1]), "ms": round((time.perf_counter() - t) * 1000)}
    except Exception as e:
        out["embed"] = {"ok": False, "error": str(e)}
    return out
