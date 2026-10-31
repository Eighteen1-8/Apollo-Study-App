"""Provider selection (local vs OpenRouter), request shaping and error handling. No network: HTTP is mocked."""
import json
import subprocess
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from studyapp import config, db, llm
from studyapp.api import app

REPO = Path(__file__).resolve().parents[2]


def mock_transport(monkeypatch, handler):
    """Route every llm._client() request through `handler(request) -> httpx.Response`."""
    real = llm._client

    def client(cfg, timeout=1800):
        c = real(cfg, timeout)
        return httpx.Client(base_url=c.base_url, headers=c.headers, transport=httpx.MockTransport(handler))

    monkeypatch.setattr(llm, "_client", client)
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)


# ---------------------------------------------------------------- defaults & resolution

def test_online_is_off_by_default():
    assert config.DEFAULT_SETTINGS["llm_provider"] == "local"
    assert config.DEFAULT_SETTINGS["embed_provider"] == "local"
    assert db.setting("llm_provider") == "local"
    assert llm.llm_cfg()["online"] is False
    assert llm.embed_cfg()["online"] is False


def test_openrouter_defaults():
    d = config.DEFAULT_SETTINGS
    assert d["openrouter_base_url"] == "https://openrouter.ai/api/v1"
    assert d["openrouter_model"] == "google/gemma-4-26b-a4b-it:free"
    assert d["openrouter_embed_model"] == "nvidia/nemotron-3.5-embed-1b:free"


def test_local_config_resolves_local_settings(settings):
    settings(llm_base_url="http://127.0.0.1:8080/v1", llm_model="qwen-test", llm_context=1000, llm_concurrency=1)
    cfg = llm.llm_cfg()
    assert (cfg["base_url"], cfg["model"], cfg["context"], cfg["online"]) == ("http://127.0.0.1:8080/v1", "qwen-test", 1000, False)
    assert llm.context_tokens() == 1000


def test_chat_and_embeddings_switch_independently(settings):
    settings(llm_provider="openrouter", openrouter_model="or/chat", openrouter_context=5000,
             embed_model="local-embed", openrouter_embed_model="or/embed")
    assert llm.llm_cfg()["model"] == "or/chat" and llm.llm_cfg()["online"]
    assert llm.context_tokens() == 5000
    assert llm.embed_model() == "local-embed"  # embeddings still local
    settings(embed_provider="openrouter")
    assert llm.embed_model() == "or/embed"
    settings(llm_provider="local")
    assert llm.llm_cfg()["online"] is False and llm.embed_cfg()["online"] is True


def test_concurrency_gate_follows_provider(settings):
    settings(llm_provider="openrouter", openrouter_concurrency=3)
    llm._gate()
    assert llm._gate_size == 3
    settings(llm_provider="local", llm_concurrency=1)
    llm._gate()
    assert llm._gate_size == 1


# ---------------------------------------------------------------- reasoning

@pytest.mark.parametrize("level,local,online", [
    ("off", {"chat_template_kwargs": {"enable_thinking": False}}, {"reasoning": {"enabled": False}}),
    ("low", {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": "low"}, {"reasoning": {"effort": "low"}}),
    ("medium", {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": "medium"}, {"reasoning": {"effort": "medium"}}),
    ("xhigh", {"chat_template_kwargs": {"enable_thinking": True}, "reasoning_effort": "xhigh"}, {"reasoning": {"effort": "high"}}),
])
def test_reasoning_fields(level, local, online):
    assert llm.reasoning_fields(level) == local
    assert llm.reasoning_fields(level, online=True) == online


# ---------------------------------------------------------------- request shaping

def test_openrouter_chat_request(monkeypatch, settings):
    settings(llm_provider="openrouter", openrouter_api_key="sk-test", openrouter_model="or/chat")
    seen = {}

    def handler(req):
        seen.update(url=str(req.url), auth=req.headers.get("authorization"), title=req.headers.get("x-title"), body=json.loads(req.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": " hi "}, "finish_reason": "stop"}]})

    mock_transport(monkeypatch, handler)
    out = llm.chat([{"role": "user", "content": "x"}], reasoning="xhigh")
    assert out["content"] == "hi"
    assert seen["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert seen["auth"] == "Bearer sk-test" and seen["title"] == "Apollo Study"
    assert seen["body"]["model"] == "or/chat" and seen["body"]["reasoning"] == {"effort": "high"}
    assert "chat_template_kwargs" not in seen["body"]


def test_local_chat_request_has_no_online_headers(monkeypatch, settings):
    settings(llm_base_url="http://127.0.0.1:8080/v1", llm_api_key="", llm_model="qwen")
    seen = {}

    def handler(req):
        seen.update(url=str(req.url), headers=req.headers, body=json.loads(req.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    mock_transport(monkeypatch, handler)
    llm.chat([{"role": "user", "content": "x"}])
    assert seen["url"].startswith("http://127.0.0.1:8080/v1")
    assert "x-title" not in seen["headers"] and "authorization" not in seen["headers"]
    assert seen["body"]["chat_template_kwargs"] == {"enable_thinking": False}


@pytest.mark.parametrize("model,prefixed", [("text-embedding-qwen3-embedding-4b", True), ("nvidia/nemotron-3.5-embed-1b:free", False)])
def test_query_prefix_only_for_qwen3(monkeypatch, settings, model, prefixed):
    if "nvidia" in model:
        settings(embed_provider="openrouter", openrouter_embed_model=model)
    else:
        settings(embed_provider="local", embed_model=model)
    sent = {}

    def handler(req):
        sent.update(json.loads(req.content))
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [3.0, 4.0]}]})

    mock_transport(monkeypatch, handler)
    v = llm.embed(["what is a wave"], query=True)
    assert sent["model"] == model
    assert sent["input"][0].startswith("Instruct:") is prefixed
    assert v.shape == (1, 2) and abs(float((v ** 2).sum()) - 1) < 1e-5  # normalised


# ---------------------------------------------------------------- errors & retries

def test_retries_rate_limits_then_succeeds(monkeypatch, settings):
    settings(llm_provider="openrouter")
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) < 3:
            return httpx.Response(429, json={"error": {"message": "rate limited"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    mock_transport(monkeypatch, handler)
    assert llm.chat([{"role": "user", "content": "x"}])["content"] == "ok"
    assert len(calls) == 3


def test_gives_up_after_retries(monkeypatch, settings):
    settings(llm_provider="openrouter")
    mock_transport(monkeypatch, lambda req: httpx.Response(429, text="slow down"))
    with pytest.raises(RuntimeError, match="HTTP 429"):
        llm.chat([{"role": "user", "content": "x"}])


def test_daily_cap_is_not_retried(monkeypatch, settings):
    settings(llm_provider="openrouter")
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(429, json={"error": {"message": "Rate limit exceeded: free-models-per-day"}})

    mock_transport(monkeypatch, handler)
    with pytest.raises(RuntimeError, match="free-models-per-day"):
        llm.chat([{"role": "user", "content": "x"}])
    with pytest.raises(RuntimeError, match="free-models-per-day"):
        list(llm.chat_stream([{"role": "user", "content": "x"}]))
    assert len(calls) == 2


def test_error_inside_200_is_raised(monkeypatch, settings):
    settings(llm_provider="openrouter")
    mock_transport(monkeypatch, lambda req: httpx.Response(200, json={"error": {"message": "Provider returned error"}}))
    with pytest.raises(RuntimeError, match="Provider returned error"):
        llm.chat([{"role": "user", "content": "x"}])


def test_bad_key_message(monkeypatch, settings):
    settings(llm_provider="openrouter")
    mock_transport(monkeypatch, lambda req: httpx.Response(401, json={"error": {"message": "No auth credentials found"}}))
    with pytest.raises(RuntimeError, match="OpenRouter HTTP 401"):
        llm.chat([{"role": "user", "content": "x"}])


def sse(*events):
    lines = [": OPENROUTER PROCESSING", ""] + [f"data: {json.dumps(e)}" for e in events] + ["data: [DONE]", ""]
    return "\n".join(lines).encode()


def test_stream_reasoning_content_and_tools(monkeypatch, settings):
    settings(llm_provider="openrouter")
    body = sse(
        {"choices": [{"delta": {"reasoning": "thinking"}}]},
        {"choices": [{"delta": {"content": "Hel"}}]},
        {"choices": [{"delta": {"content": "lo"}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t1", "function": {"name": "make_quiz", "arguments": "{\"n\":"}}]}}]},
        {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": "5}"}}]}, "finish_reason": "tool_calls"}]},
    )
    mock_transport(monkeypatch, lambda req: httpx.Response(200, content=body, headers={"content-type": "text/event-stream"}))
    out = list(llm.chat_stream([{"role": "user", "content": "x"}], tools=[{"type": "function"}]))
    assert ("reasoning", "thinking") in out
    assert "".join(t for k, t in out if k == "content") == "Hello"
    assert ("tool_calls", [{"id": "t1", "name": "make_quiz", "arguments": {"n": 5}}]) in out
    assert out[-1] == ("done", "tool_calls")


def test_stream_retries_rate_limit_before_data(monkeypatch, settings):
    settings(llm_provider="openrouter")
    calls = []

    def handler(req):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(429, json={"error": {"message": "temporarily rate-limited upstream"}})
        return httpx.Response(200, content=sse({"choices": [{"delta": {"content": "ok"}, "finish_reason": "stop"}]}))

    mock_transport(monkeypatch, handler)
    out = list(llm.chat_stream([{"role": "user", "content": "x"}]))
    assert ("content", "ok") in out and len(calls) == 2


def test_stream_error_event_raises(monkeypatch, settings):
    settings(llm_provider="openrouter")
    body = sse({"choices": [{"delta": {"content": "par"}}]}, {"error": {"message": "upstream died"}})
    mock_transport(monkeypatch, lambda req: httpx.Response(200, content=body))
    with pytest.raises(RuntimeError, match="upstream died"):
        list(llm.chat_stream([{"role": "user", "content": "x"}]))


# ---------------------------------------------------------------- API & secrets

def test_settings_api_masks_openrouter_key(settings):
    settings(openrouter_api_key="sk-or-secret")
    c = TestClient(app)
    s = c.get("/settings").json()
    assert s["openrouter_api_key"] == "••••••••"
    assert "sk-or-secret" not in json.dumps(s)
    # saving the masked value back must keep the real key
    c.put("/settings", json={**s, "llm_provider": "openrouter"})
    assert db.setting("openrouter_api_key") == "sk-or-secret"
    assert db.setting("llm_provider") == "openrouter"


def test_embedding_status_uses_effective_model(settings):
    settings(embed_provider="openrouter", openrouter_embed_model="or/embed")
    assert TestClient(app).get("/embedding-status").json()["current"] == "or/embed"


def test_api_key_not_in_tracked_files():
    prefix = "sk-or-" + "v1"  # split so this file does not match itself
    tracked = subprocess.run(["git", "grep", "-l", prefix, "--", "."], cwd=REPO, capture_output=True, text=True)
    assert tracked.stdout.strip() == "", f"OpenRouter key committed in: {tracked.stdout}"
    ignored = subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=REPO)
    assert ignored.returncode == 0, ".env must stay gitignored"
