"""Structured output without server-side constrained decoding: schema in the prompt, parse, validate, repair."""
import json
import re

from pydantic import BaseModel, ValidationError

from test_llm import chat

FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text):
    m = FENCE.search(text)
    text = m.group(1) if m else text
    start = min((i for i in (text.find("{"), text.find("[")) if i >= 0), default=-1)
    end = max(text.rfind("}"), text.rfind("]"))
    return json.loads(text[start:end + 1])


def chat_json(messages, model: type[BaseModel], retries=2, **kw):
    """Returns (parsed, attempts). Appends the schema to the system prompt and repairs on failure."""
    schema = json.dumps(model.model_json_schema())
    sys_msg = {"role": "system", "content": "Respond with ONLY a JSON object matching this JSON Schema, no prose, no code fences:\n" + schema}
    msgs = [sys_msg, *messages]
    for attempt in range(1, retries + 2):
        res, _, err = chat(msgs, **kw)
        if err:
            raise RuntimeError(err)
        content = res["choices"][0]["message"]["content"] or ""
        try:
            return model.model_validate(extract_json(content)), attempt
        except (ValueError, ValidationError) as e:
            msgs = [*msgs, {"role": "assistant", "content": content},
                    {"role": "user", "content": f"That was invalid ({str(e)[:400]}). Return ONLY the corrected JSON."}]
    raise RuntimeError("JSON repair failed")
