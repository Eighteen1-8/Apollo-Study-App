"""A stand-in for the model servers in the end-to-end smoke run: an OpenAI-compatible API on one port that answers
chat (streamed or not) with a fixed reply, and embeddings with deterministic vectors. Run with the backend's Python:
    python fake_llm.py PORT"""
import hashlib
import json
import sys
import time

import numpy as np
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

REPLY = "Hello from the fake model. Projectile motion splits into **horizontal** and vertical parts."
app = FastAPI()


@app.get("/v1/models")
def models():
    return {"data": [{"id": "fake-chat"}, {"id": "fake-embed"}]}


@app.post("/v1/chat/completions")
async def chat(req: Request):
    body = await req.json()
    usage = {"prompt_tokens": 120, "completion_tokens": 18, "total_tokens": 138}
    if not body.get("stream"):
        text = "Fake title" if "title" in json.dumps(body["messages"]).lower() else REPLY
        return JSONResponse({"choices": [{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                             "usage": usage})

    def events():
        for word in REPLY.split(" "):
            yield f"data: {json.dumps({'choices': [{'delta': {'content': word + ' '}, 'finish_reason': None}]})}\n\n"
            time.sleep(0.02)
        yield f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
        yield f"data: {json.dumps({'choices': [], 'usage': usage})}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(events(), media_type="text/event-stream")


@app.post("/v1/embeddings")
async def embeddings(req: Request):
    body = await req.json()
    texts = body["input"] if isinstance(body["input"], list) else [body["input"]]
    data = []
    for i, t in enumerate(texts):
        seed = int.from_bytes(hashlib.sha256(t.encode()).digest()[:4], "little")
        v = np.random.default_rng(seed).normal(size=64)
        data.append({"index": i, "embedding": (v / np.linalg.norm(v)).tolist()})
    return {"data": data, "model": body.get("model")}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
