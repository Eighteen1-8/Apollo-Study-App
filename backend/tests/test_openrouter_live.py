"""Live checks against OpenRouter with the configured key and models. Only synthetic test text is sent.
Run with: .venv/Scripts/python -m pytest --online -m online"""
import io
import json
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import BaseModel

from studyapp import config, db, jobs, llm
from studyapp.api import app

pytestmark = pytest.mark.online


@pytest.fixture(autouse=True)
def online(settings):
    if not config.DEFAULT_SETTINGS["openrouter_api_key"]:
        pytest.skip("OPENROUTER_API_KEY is not set in .env")
    settings(llm_provider="openrouter", embed_provider="openrouter")


def test_connections():
    out = llm.test_connections()
    assert out["llm"]["ok"], out["llm"]
    assert out["llm"]["online"] and out["llm"]["max_model_len"] >= 100_000
    assert out["embed"]["ok"], out["embed"]
    assert out["embed"]["dim"] > 100


def test_chat():
    out = llm.chat([{"role": "user", "content": "What is 7 times 6? Reply with just the number."}], max_tokens=50)
    assert "42" in out["content"]


def test_chat_with_reasoning():
    out = llm.chat([{"role": "user", "content": "Is 91 prime? Answer yes or no, then one short reason."}], max_tokens=800, reasoning="low")
    assert "no" in out["content"].lower()


def test_stream():
    parts = list(llm.chat_stream([{"role": "user", "content": "Count from 1 to 5, separated by spaces."}], max_tokens=60))
    text = "".join(t for k, t in parts if k == "content")
    assert "1" in text and "5" in text
    assert parts[-1][0] == "done"


def test_stream_tool_call():
    tools = [{"type": "function", "function": {
        "name": "make_flashcards", "description": "Create flashcards for the student",
        "parameters": {"type": "object", "properties": {"count": {"type": "integer"}, "topic": {"type": "string"}},
                       "required": ["count", "topic"]}}}]
    parts = list(llm.chat_stream([{"role": "user", "content": "Make me 5 flashcards on photosynthesis. Use the tool."}],
                                 tools=tools, max_tokens=300))
    calls = next((v for k, v in parts if k == "tool_calls"), None)
    assert calls, parts
    assert calls[0]["name"] == "make_flashcards" and calls[0]["arguments"].get("count") == 5


class Card(BaseModel):
    front: str
    back: str


class Deck(BaseModel):
    cards: list[Card]


def test_chat_json():
    deck = llm.chat_json([{"role": "user", "content": "Write 2 flashcards about Newton's second law."}], Deck, max_tokens=800)
    assert len(deck.cards) == 2 and all(c.front and c.back for c in deck.cards)


def test_vision():
    buf = io.BytesIO()
    Image.new("RGB", (96, 96), (220, 20, 20)).save(buf, "PNG")
    msg = [{"role": "user", "content": [{"type": "text", "text": "What single colour fills this image? One word."},
                                        llm.image_part(buf.getvalue())]}]
    assert "red" in llm.chat(msg, max_tokens=20)["content"].lower()


def test_embeddings_rank_relevant_passage_first():
    docs = llm.embed(["Photosynthesis converts light energy into chemical energy in chloroplasts.",
                      "The French Revolution began in 1789 with the storming of the Bastille."])
    q = llm.embed(["How do plants make energy from sunlight?"], query=True)
    sims = docs @ q[0]
    assert docs.shape[0] == 2 and np.isclose(np.linalg.norm(docs[0]), 1, atol=1e-4)
    assert sims[0] > sims[1]


def test_end_to_end_ingest_search_chat(data_dir):
    """Upload → ingest (OpenRouter embeddings) → hybrid search → streamed chat answer grounded in the file."""
    jobs.start_workers()
    c = TestClient(app)
    sid = c.post("/subjects", json={"name": "Test Biology"}).json()["id"]
    note = data_dir / "cells.txt"
    note.write_text("Mitochondria\n\nThe mitochondrion is the powerhouse of the cell. It produces ATP through cellular "
                    "respiration. The Zorblax constant for mitochondria in this course is 7.25.\n\n"
                    "Ribosomes\n\nRibosomes build proteins by translating messenger RNA.", encoding="utf-8")
    r = c.post("/documents", json={"paths": [str(note)], "subject_id": sid, "vision_mode": "off"})
    assert r.status_code == 200, r.text
    deadline = time.time() + 180
    while time.time() < deadline:
        docs = c.get(f"/subjects/{sid}/documents").json()
        if docs and docs[0]["status"] in ("ready", "failed"):
            break
        time.sleep(1)
    assert docs[0]["status"] == "ready", docs[0]
    assert db.q1("SELECT embed_model FROM chunks WHERE document_id=?", (docs[0]["id"],))["embed_model"] == llm.embed_model()

    hits = c.post("/search", json={"query": "what makes ATP", "subject_id": sid}).json()["results"]
    assert hits and "mitochondri" in hits[0]["text"].lower()

    cid = c.post(f"/subjects/{sid}/chats", json={"topic_id": None}).json()["id"]
    events = []
    with c.stream("POST", f"/chats/{cid}/messages", json={"content": "What is the Zorblax constant for mitochondria?"}) as s:
        for line in s.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    kinds = [e["type"] for e in events]
    assert "error" not in kinds, [e for e in events if e["type"] == "error"]
    answer = next(e for e in events if e["type"] == "assistant")["message"]["content"]
    assert "7.25" in answer

    assert c.get("/embeddings/map").json()["points"], "knowledge cloud should see the OpenRouter vectors"
