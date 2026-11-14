"""Marking the student's own work with a fake model: files are copied (never ingested), every call shares one system
prompt, pages go as pictures in batches, criteria are derived when there's no rubric, material is optional, and the
copies go when the content is purged."""
import io
import json
import time

import pytest
from docx import Document
from fastapi.testclient import TestClient
from PIL import Image

from studyapp import config, db, generate, marking, study_api
from studyapp.api import app

client = TestClient(app)


class _Job:
    id = 0
    cancelled = False

    def check(self):
        if self.cancelled:
            raise generate.pipeline.Cancelled()

    def update(self, *a):
        pass


@pytest.fixture
def subject():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Marking', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Forces', ?)", (sid, now))
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
                "token_count, created_at, updated_at) VALUES (?,?,'topic','lecture.pdf','.pdf','mark-sha',1,'ready','off',1,20,?,?)",
                (sid, tid, now, now))
    db.ex("INSERT INTO units(document_id, idx, kind, label, text, content_hash, token_count) VALUES (?, 1, 'page', 'Page 1', "
          "'Newton''s second law: F = ma.', 'mark-u1', 10)", (did,))
    yield {"sid": sid, "tid": tid, "did": did}
    db.ex("DELETE FROM jobs WHERE type='generate'")
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


@pytest.fixture
def files(tmp_path):
    essay = tmp_path / "essay.docx"
    d = Document()
    d.add_heading("Forces", 1)
    d.add_paragraph("A force makes things accelerate. F = m a, so a 2 kg mass pushed with 4 N accelerates at 3 m/s².")
    d.save(essay)
    photo = tmp_path / "working.jpg"
    buf = io.BytesIO()
    Image.new("RGB", (3000, 1500), "white").save(buf, "JPEG")
    photo.write_bytes(buf.getvalue())
    rubric = tmp_path / "rubric.txt"
    rubric.write_text("Q1 (4 marks): states Newton's second law and applies it correctly.\nQ2 (2 marks): units.", encoding="utf-8")
    return {"essay": essay, "photo": photo, "rubric": rubric}


@pytest.fixture
def model(monkeypatch):
    """Fake chat_json: answers by schema and records every call."""
    calls = []

    def fake(messages, schema, **kw):
        calls.append({"schema": schema.__name__, "messages": messages, "reasoning": kw.get("reasoning")})
        if schema is marking.Criteria:
            return marking.Criteria(task="Explain forces", criteria=[marking.Criterion(label="Understanding", max=6),
                                                                     marking.Criterion(label="Communication", max=4)])
        if schema is marking.Batch:
            labels = ["Understanding", "Communication"] if "Understanding" in json.dumps(messages[-1]["content"]) else ["Q1", "Q2"]
            return marking.Batch(items=[
                marking.MarkItem(label=labels[0], awarded=3, max=4 if labels[0] == "Q1" else 6, feedback="2 kg at 4 N is 2 m/s², not 3.",
                                 corrections=["a = F/m = 4/2 = 2 m/s²"], quote="accelerates at 3 m/s²", page=1),
                marking.MarkItem(label=labels[1], awarded=9, max=2 if labels[1] == "Q2" else 4, feedback="Units given.")])
        return marking.Summary(overall="Good start.", strengths=["Clear law"], improvements=["Check arithmetic"])
    monkeypatch.setattr(marking.llm, "chat_json", fake)
    monkeypatch.setattr(marking, "_office_pdf", lambda path, aid: None)  # no Office conversion in tests
    return calls


def _run(aid):
    generate.run_artifact(aid, _Job())
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (aid,))
    assert a["status"] == "ready", a["error"]
    return json.loads(a["content"])["marking"], json.loads(a["params"])


def test_marking_with_rubric_and_material(subject, files, model):
    r = client.post(f"/subjects/{subject['sid']}/artifacts", json={
        "type": "marking", "topic_id": subject["tid"], "instructions": "Be strict about units",
        "args": {"work_paths": [str(files["essay"]), str(files["photo"])], "rubric_path": str(files["rubric"]), "out_of": 12}})
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    assert r.json()["title"] == "Marking: essay +1"
    try:
        result, params = _run(aid)
        # the copies, not the originals; nothing ingested
        assert [w["name"] for w in params["work"]] == ["essay.docx", "working.jpg"] and params["rubric"]["name"] == "rubric.txt"
        assert all((config.assets_dir() / w["file"]).is_file() for w in params["work"])
        assert not db.q("SELECT id FROM documents WHERE filename IN ('essay.docx', 'working.jpg', 'rubric.txt')")
        # one batch (one picture: the photo, scaled down), then the summary; no criteria call with a rubric
        assert [c["schema"] for c in model] == ["Batch", "Summary"]
        systems = {c["messages"][0]["content"] for c in model}
        assert len(systems) == 1  # the same system prompt every call (prefix cache)
        system = systems.pop()
        assert "Q1 (4 marks)" in system and "F = ma" in system
        first = model[0]["messages"][1]["content"]
        assert "accelerates at 3" in first[0]["text"] and "Be strict about units" in first[0]["text"]
        assert model[0]["messages"][1]["content"][0] == model[1]["messages"][1]["content"][0]  # same first user block
        images = [p for p in first if p.get("type") == "image_url"]
        assert len(images) == 1 and images[0]["image_url"]["url"].startswith("data:image/jpeg")
        assert all(c["reasoning"] == db.setting("marking_reasoning") for c in model)
        # marks: clamped to each question's max, scaled to "out of 12"
        q = {c["label"]: c for c in result["criteria"]}
        assert q["Q1"]["awarded"] == 3 and q["Q2"]["awarded"] == 2 and q["Q1"]["quotes"][0]["page"] == 1
        assert result["raw"] == {"awarded": 5, "available": 6} and result["scaled"] and result["score"] == 10.0 and result["out_of"] == 12
        assert result["overall"] == "Good start." and result["material"]
        shown = [p for p in result["pages"] if p.get("asset")]
        assert len(shown) == 1 and (config.assets_dir() / shown[0]["asset"]).is_file()
        assert any(p.get("text") and "accelerate" in p["text"] for p in result["pages"])  # the Word file, shown as text
        from test_api_contract import check  # the UI's types (api.ts)
        check(client.get(f"/artifacts/{aid}").json(), "Artifact")
        check(result, "MarkingResult")
        check(result["criteria"][0], "MarkingCriterion")
    finally:
        db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
        marking.remove_files(aid)


def test_marking_without_rubric_or_material(subject, files, model):
    r = client.post(f"/subjects/{subject['sid']}/artifacts", json={
        "type": "marking", "topic_id": subject["tid"], "args": {"work_paths": [str(files["essay"])], "against": "nothing"}})
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    try:
        result, params = _run(aid)
        assert params["material"] is False and params["out_of"] is None
        assert db.q1("SELECT topic_id FROM artifacts WHERE id=?", (aid,))["topic_id"] is None
        assert [c["schema"] for c in model] == ["Criteria", "Batch", "Summary"]
        assert "STUDY MATERIAL" not in model[0]["messages"][0]["content"] and "no marking guide" in model[0]["messages"][0]["content"]
        assert "Understanding (6 marks)" in model[1]["messages"][1]["content"][1]["text"]
        assert result["derived"] and [c["label"] for c in result["criteria"]] == ["Understanding", "Communication"]
        assert result["score"] == 7 and result["out_of"] == 10 and not result["scaled"] and result["material"] is None
        # purged a week after it's deleted: the copies go with it
        db.ex("UPDATE artifacts SET deleted_at=? WHERE id=?", (time.time() - 8 * 86400, aid))
        assert marking.folder(aid).is_dir()
        study_api.purge_deleted()
        assert not marking.folder(aid).exists()
    finally:
        db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
        marking.remove_files(aid)


def test_marking_requests_are_checked(subject, files, monkeypatch, tmp_path):
    sid = subject["sid"]
    post = lambda args: client.post(f"/subjects/{sid}/artifacts", json={"type": "marking", "args": args})  # noqa: E731
    assert post({}).status_code == 400
    assert post({"work_paths": [str(tmp_path / "missing.docx")]}).json()["code"] == "APO-FILE-301"
    (tmp_path / "x.zip").write_bytes(b"PK")
    assert post({"work_paths": [str(tmp_path / "x.zip")]}).json()["code"] == "APO-FILE-303"
    assert post({"work_paths": [str(files["essay"])], "out_of": "lots"}).status_code == 400
    assert not db.q("SELECT id FROM artifacts WHERE subject_id=?", (sid,))
    # too many pages: a plain error, not a model call
    monkeypatch.setattr(marking, "MAX_PAGES", 0)
    monkeypatch.setattr(marking.llm, "chat_json", lambda *a, **k: pytest.fail("called the model"))
    aid = post({"work_paths": [str(files["photo"])], "against": "nothing"}).json()["id"]
    try:
        with pytest.raises(Exception) as e:
            generate.run_artifact(aid, _Job())
        assert "APO-GEN-404" in str(e.value)
    finally:
        db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
        marking.remove_files(aid)
