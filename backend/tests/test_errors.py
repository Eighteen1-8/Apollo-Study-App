"""Error codes: every failure the student sees carries a code from errors.CATALOGUE, the API answers with
{detail, code, technical}, and docs/ERRORS.md matches the catalogue."""
import sqlite3
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from studyapp import errors, llm
from studyapp.api import app

client = TestClient(app)


def test_classify_known_failures():
    assert errors.classify(httpx.ConnectError("refused"), "llm").code == "APO-LLM-101"
    assert errors.classify(httpx.ConnectError("refused"), "embed").code == "APO-EMB-201"
    assert errors.classify(httpx.ReadTimeout("slow"), "llm").code == "APO-LLM-102"
    assert errors.classify(httpx.UnsupportedProtocol("ftp"), "llm").code == "APO-SET-701"
    assert errors.classify(sqlite3.OperationalError("database is locked")).code == "APO-DATA-501"
    assert errors.classify(FileNotFoundError("x.pdf")).code == "APO-FILE-301"
    assert errors.classify(llm.Paused("The language model is paused.")).code == "APO-LLM-110"
    assert errors.classify(llm.Paused("The embedding model is paused.")).code == "APO-EMB-207"
    # context.material_problem's words are kept: they already say what to do
    e = errors.classify(ValueError("The topic 'Waves' has no files yet. Upload files to it."))
    assert e.code == "APO-GEN-401" and "Waves" in e.plain
    assert errors.classify(KeyError("boom")).code == "APO-APP-900"
    assert str(errors.AppError("APO-LLM-101")).endswith(" [APO-LLM-101]")


def test_model_http_answers_get_their_own_codes():
    assert errors.http_error(401, "bad key", "llm", "x").code == "APO-LLM-103"
    assert errors.http_error(429, "slow down", "embed", "x").code == "APO-EMB-205"
    assert errors.http_error(404, "model qwen not found", "llm", "x").code == "APO-LLM-104"
    assert errors.http_error(400, "This model's maximum context length is 8192 tokens", "llm", "x").code == "APO-LLM-106"
    assert errors.http_error(500, "CUDA out of memory", "llm", "x").code == "APO-LLM-108"
    assert errors.http_error(400, "unknown field reasoning_effort", "llm", "x").code == "APO-LLM-109"


def test_api_errors_carry_a_code():
    r = client.get("/artifacts/999999")
    assert r.status_code == 404 and r.json()["code"] == "APO-DATA-504"
    r = client.post("/subjects/999999/artifacts", json={"type": "nope"})
    assert r.json()["code"] == "APO-APP-400"
    r = client.post("/subjects/1/artifacts", json={})  # missing field: pydantic validation
    assert r.status_code == 422 and r.json()["code"] == "APO-APP-400"
    codes = {e["code"] for e in client.get("/errors").json()}
    assert codes == set(errors.CATALOGUE)


def test_every_code_has_complete_entry_and_the_document_is_current():
    for code, i in errors.CATALOGUE.items():
        assert errors.CODE_RE.fullmatch(f"[{code}]"), code
        assert i.title and i.plain and i.meaning and i.causes and i.fixes, code
    doc = Path(__file__).resolve().parents[2] / "docs" / "ERRORS.md"
    assert doc.read_text(encoding="utf-8") == errors.markdown(), "regenerate: python -m studyapp.errors > ../docs/ERRORS.md"


def test_model_status_reports_codes(settings):
    settings(llm_provider="local", embed_provider="local", llm_base_url="http://127.0.0.1:9/v1", embed_base_url="http://127.0.0.1:9/v1")
    st = llm.model_status()
    assert st["llm"]["code"] == "APO-LLM-101" and st["embed"]["code"] == "APO-EMB-201"
    assert st["llm"]["error"].endswith(" [APO-LLM-101]")
