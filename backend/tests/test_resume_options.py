"""Generation with a fake model: exams share questions out per document section, quiz difficulty and question types,
finished parts saved as they finish so a retry continues (and a Regenerate of ready content starts over), marking a
new version of the same work, create tools narrowed to a file's pages from the chat, Office copy failures recorded
per document, and concise checks with citations."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from studyapp import chat_tools, db, errors, generate, maintenance, marking, render, review
from studyapp.api import app

from test_marking import _Job, files, model  # noqa: F401 (fixtures)

client = TestClient(app)


def _doc(sid, tid, name, pages, words=40):
    now = time.time()
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
                "token_count, created_at, updated_at) VALUES (?,?,'topic',?,?,?,1,'ready','off',?,?,?,?)",
                (sid, tid, name, "." + name.rsplit(".", 1)[1], f"sha-{name}-{now}", pages, pages * words, now, now))
    for i in range(1, pages + 1):
        text = f"{name} page {i}: " + " ".join(f"word{i}x{k}" for k in range(words))
        db.ex("INSERT INTO units(document_id, idx, kind, label, text, content_hash, token_count) VALUES (?,?,?,?,?,?,?)",
              (did, i, "slide" if name.endswith(".pptx") else "page", f"{'Slide' if name.endswith('.pptx') else 'Page'} {i}",
               text, f"h-{did}-{i}", words))
    return did


@pytest.fixture
def subject():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Resume', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'Waves', ?)", (sid, now))
    big = _doc(sid, tid, "big.pdf", 4, words=100)
    small = _doc(sid, tid, "small.pdf", 1, words=100)
    yield {"sid": sid, "tid": tid, "big": big, "small": small}
    db.ex("DELETE FROM jobs WHERE type='generate'")
    db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def _artifact(sid, tid, kind, params):
    now = time.time()
    return db.ex("INSERT INTO artifacts(subject_id, topic_id, type, title, params, status, created_at, updated_at) "
                 "VALUES (?,?,?,?,?, 'queued', ?, ?)", (sid, tid, kind, kind.title(), json.dumps(params), now, now))


def _quiz_model(monkeypatch, fail_at=None):
    calls = []

    def fake(messages, schema, **kw):
        calls.append(messages[-1]["content"])
        if fail_at is not None and len(calls) == fail_at:
            raise RuntimeError("model fell over")
        n = int(messages[-1]["content"].split("Write exactly ", 1)[1].split(" ", 1)[0])
        tf = "true/false questions (type 'tf')" in messages[-1]["content"]
        return generate.MCQs(questions=[generate.MCQ(
            type="tf" if tf else "mcq", question=f"Q{len(calls)}.{k}?", options=["False", "True"] if tf else ["a", "b", "c", "d"],
            answer_index=0, explanation="because") for k in range(n)])
    monkeypatch.setattr(generate.llm, "chat_json", fake)
    monkeypatch.setattr(generate, "_textbook", lambda *a, **k: "")
    return calls


# ---------------------------------------------------------------- 1. exams per section

def test_exam_shares_questions_per_section(subject, monkeypatch, tmp_path):
    exam = tmp_path / "practice.txt"
    exam.write_text("Section A. Answer all questions. 1. What is a wave? (2 marks)", encoding="utf-8")
    bp = generate.Blueprint(title="Practice", total_marks=10, parts=[generate.BPPart(
        name="A", question_type="short", count=7, marks_each=2)], difficulty_profile="recall", subject_guess="physics",
        matches_subject=True)
    tasks = []

    def fake(messages, schema, **kw):
        if schema is generate.Blueprint:
            return bp
        task = messages[-1]["content"]
        tasks.append(task)
        n = int(task.split("Write ", 1)[1].split(" ", 1)[0])
        return generate.ExamQs(questions=[generate.ExamQ(type="short", prompt=f"New question {len(tasks)}.{k} about waves",
                                                         marks=99, model_answer="x") for k in range(n)])
    monkeypatch.setattr(generate.llm, "chat_json", fake)
    monkeypatch.setattr(generate, "_textbook", lambda *a, **k: "")
    aid = _artifact(subject["sid"], subject["tid"], "exam", {"difficulty": "hard", "practice_exam_path": str(exam)})
    generate.run_artifact(aid, _Job())
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (aid,))
    content = json.loads(a["content"])
    qs = content["parts"][0]["questions"]
    assert a["status"] == "ready" and len(qs) == 7 and a["partial"] is None
    assert all(q["marks"] == 2 for q in qs)  # marks normalised to the blueprint
    assert content["total_marks"] == 14
    # one call per section with a share: the small file gets its own question instead of losing out in its group
    assert [t.split("document section '", 1)[1].split("'", 1)[0] for t in tasks] == ["big.pdf", "small.pdf"]
    assert tasks[0].startswith("Write 6 ") and tasks[1].startswith("Write 1 ") and all("HARD" in t for t in tasks)
    assert "Already written for this part" in tasks[1]


# ---------------------------------------------------------------- 2. quiz options

def test_quiz_difficulty_and_types(subject, monkeypatch):
    calls = _quiz_model(monkeypatch)
    r = client.post(f"/subjects/{subject['sid']}/artifacts", json={
        "type": "quiz", "topic_id": subject["tid"], "args": {"count": 4, "difficulty": "easy", "types": ["tf", "nope"]}})
    assert r.status_code == 200, r.text
    aid = r.json()["id"]
    params = json.loads(db.q1("SELECT params FROM artifacts WHERE id=?", (aid,))["params"])
    assert params["types"] == ["tf"] and params["difficulty"] == "easy"
    generate.run_artifact(aid, _Job())
    qs = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (aid,))["content"])["questions"]
    assert len(qs) == 4 and all(q["type"] == "tf" and q["options"] == ["True", "False"] for q in qs)
    assert all(q["answer_index"] == 1 for q in qs)  # "False" first was flipped to True-first
    assert all("EASY" in c for c in calls)
    bad = client.post(f"/subjects/{subject['sid']}/artifacts", json={"type": "quiz", "args": {"difficulty": "brutal"}})
    assert bad.status_code == 400
    with pytest.raises(ValueError):
        generate.MCQ(question="?", options=["a", "b"], answer_index=0, explanation="")  # mcq needs 4


# ---------------------------------------------------------------- 3. resume

def test_failed_generation_resumes_and_regenerate_starts_over(subject, monkeypatch):
    calls = _quiz_model(monkeypatch, fail_at=2)
    aid = _artifact(subject["sid"], subject["tid"], "quiz", {"count": 7})
    with pytest.raises(RuntimeError):
        generate.run_artifact(aid, _Job())
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (aid,))
    assert a["content"] is None and len(json.loads(a["partial"])["done"]) == 1  # the first section was kept
    assert client.get(f"/artifacts/{aid}").json()["resumable"] is True
    db.ex("UPDATE artifacts SET status='failed' WHERE id=?", (aid,))
    client.post(f"/artifacts/{aid}/retry")
    assert db.q1("SELECT partial FROM artifacts WHERE id=?", (aid,))["partial"]  # a retry after a failure keeps it
    before = len(calls)
    generate.run_artifact(aid, _Job())
    a = db.q1("SELECT * FROM artifacts WHERE id=?", (aid,))
    assert a["status"] == "ready" and a["partial"] is None and len(json.loads(a["content"])["questions"]) == 7
    assert len(calls) - before == 1  # one call per file here; the finished one wasn't asked again
    # changed params: the saved parts don't apply
    p = generate.Partial({**a, "partial": json.dumps({"key": "other", "done": {"x": 1}})}, {"count": 7})
    assert p.done == {}
    # a deliberate Regenerate of ready content starts fresh
    db.ex("UPDATE artifacts SET partial=? WHERE id=?", (json.dumps({"key": "k", "done": {"x": 1}}), aid))
    db.ex("DELETE FROM jobs WHERE type='generate' AND ref_id=?", (aid,))  # the retry's job (run by hand above)
    client.post(f"/artifacts/{aid}/retry")
    assert db.q1("SELECT partial FROM artifacts WHERE id=?", (aid,))["partial"] is None


def test_notes_resume_after_cancel(subject, monkeypatch):
    pages = []

    class Job(_Job):
        def check(self):
            if len(pages) == 1 and not getattr(self, "done_once", False):
                self.done_once = True
                raise generate.pipeline.Cancelled()

    def page(system, task, art, prog, label, **kw):
        pages.append(label)
        return {"html": "<p>" + "notes " * 60 + "</p>", "figures": {}}
    monkeypatch.setattr(generate, "_page", page)
    monkeypatch.setattr(generate, "_textbook", lambda *a, **k: "")
    aid = _artifact(subject["sid"], subject["tid"], "notes", {})
    with pytest.raises(generate.pipeline.Cancelled):
        generate.run_artifact(aid, Job())
    first = len(pages)
    generate.run_artifact(aid, _Job())
    secs = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (aid,))["content"])["sections"]
    assert len(pages) - first == len(secs) - first  # only the sections not written yet


# ---------------------------------------------------------------- 4. marking a new version

def test_mark_a_new_version(subject, files, model):  # noqa: F811
    r = client.post(f"/subjects/{subject['sid']}/artifacts", json={
        "type": "marking", "topic_id": subject["tid"], "instructions": "Be strict",
        "args": {"work_paths": [str(files["essay"])], "rubric_path": str(files["rubric"]), "out_of": 12}})
    first = r.json()["id"]
    second = None
    try:
        generate.run_artifact(first, _Job())
        r = client.post(f"/artifacts/{first}/new-version", json={"work_paths": [str(files["photo"])]})
        assert r.status_code == 200, r.text
        second = r.json()["id"]
        assert r.json()["title"].endswith("(version 2)")
        params = json.loads(db.q1("SELECT params FROM artifacts WHERE id=?", (second,))["params"])
        assert params["previous"] == first and params["out_of"] == 12 and params["instructions"] == "Be strict"
        assert params["rubric"]["name"] == "rubric.txt" and params["work"][0]["name"] == "working.jpg"
        model.clear()
        generate.run_artifact(second, _Job())
        m = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (second,))["content"])["marking"]
        assert m["previous"]["id"] == first and [h["id"] for h in m["history"]] == [first]
        assert all(c["previous"] and "awarded" in c["previous"] for c in m["criteria"])
        summary = model[-1]["messages"][1]["content"][1]["text"]
        assert "PREVIOUS MARKING" in summary and "Q1: " in summary
        assert "PREVIOUS MARKING" not in model[0]["messages"][0]["content"]  # not in the cached system prompt
        from test_api_contract import check
        check(m, "MarkingResult")
    finally:
        for aid in (first, second):
            if aid:
                db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
                marking.remove_files(aid)


def test_marking_resumes_from_its_batches(subject, files, model):  # noqa: F811
    r = client.post(f"/subjects/{subject['sid']}/artifacts", json={
        "type": "marking", "args": {"work_paths": [str(files["photo"])], "against": "nothing"}})
    aid = r.json()["id"]
    try:
        orig = marking.llm.chat_json

        def failing(messages, schema, **kw):
            if schema is marking.Summary:
                raise RuntimeError("down")
            return orig(messages, schema, **kw)
        marking.llm.chat_json = failing
        with pytest.raises(RuntimeError):
            generate.run_artifact(aid, _Job())
        marking.llm.chat_json = orig
        model.clear()
        generate.run_artifact(aid, _Job())
        assert [c["schema"] for c in model] == ["Summary"]  # criteria and the batch weren't asked again
    finally:
        db.ex("DELETE FROM artifacts WHERE id=?", (aid,))
        marking.remove_files(aid)


# ---------------------------------------------------------------- 5. chat tools on chosen pages

def test_chat_tool_on_some_slides(subject):
    now = time.time()
    deck = _doc(subject["sid"], subject["tid"], "Lecture 3.pptx", 25)
    cid = db.ex("INSERT INTO chats(subject_id, topic_id, created_at, updated_at) VALUES (?,?,?,?)", (subject["sid"], subject["tid"], now, now))
    chat = db.q1("SELECT * FROM chats WHERE id=?", (cid,))
    msg = chat_tools._tool_message(chat, "create_quiz", {"count": 5, "file": "lecture 3", "pages": "slides 10–20"})
    meta = msg["meta"] if isinstance(msg["meta"], dict) else json.loads(msg["meta"])
    assert meta["args"]["units"] == {str(deck): list(range(10, 21))} and meta["file"] == "Lecture 3.pptx"
    missing = chat_tools._tool_message(chat, "create_exam", {"file": "nowhere.pdf", "pages": "1-2"})
    mmeta = missing["meta"] if isinstance(missing["meta"], dict) else json.loads(missing["meta"])
    assert "units" not in mmeta["args"] and "nowhere.pdf" in mmeta["notice"]
    r = client.post(f"/messages/{msg['id']}/submit", json={"args": {"count": 5, "difficulty": "hard",
                                                                      "units": {str(deck): [10, 11, 12]}}, "topic_id": subject["tid"]})
    assert r.status_code == 200, r.text
    a = db.q1("SELECT * FROM artifacts WHERE chat_id=?", (cid,))
    params = json.loads(a["params"])
    assert params["units"] == {str(deck): [10, 11, 12]} and params["document_ids"] == [deck] and params["difficulty"] == "hard"
    assert a["topic_id"] is None and "slides 10–12" in a["title"]
    bad = chat_tools._tool_message(chat, "create_quiz", {})
    r = client.post(f"/messages/{bad['id']}/submit", json={"args": {"units": {str(deck): [99]}}})
    assert r.status_code == 400


# ---------------------------------------------------------------- 6. Office copy failures

def test_office_copy_failure_is_recorded_and_retried(subject, monkeypatch):
    did = _doc(subject["sid"], subject["tid"], "deck.pptx", 2)
    d = db.q1("SELECT * FROM documents WHERE id=?", (did,))
    monkeypatch.setattr(render, "export_pdf", lambda src, out, kind: str(errors.AppError(
        "APO-FILE-309", "Office: dialog", plain="Microsoft PowerPoint couldn't copy the file.")))
    monkeypatch.setattr("studyapp.pipeline.doc_path", lambda doc: render.renders_dir() / "missing.pptx")
    assert render.rendered_pdf(d) is None
    err = db.q1("SELECT render_error FROM documents WHERE id=?", (did,))["render_error"]
    assert "[APO-FILE-309]" in err and "PowerPoint" in err
    row = next(x for x in maintenance.overview()["documents"] if x["id"] == did)
    assert row["render_error"] == err
    assert client.get(f"/documents/{did}/render").json() == {"office": True, "pdf": False, "render_error": err}

    def works(src, out, kind):
        out.write_bytes(b"%PDF-1.4 fake")
        return None
    monkeypatch.setattr(render, "export_pdf", works)
    r = client.post(f"/documents/{did}/render")
    assert r.status_code == 200 and r.json() == {"ok": True, "render_error": None}
    (render.renders_dir() / f"{d['sha256']}.pdf").unlink()


def test_no_converter_says_so(monkeypatch, tmp_path):
    monkeypatch.setattr(render, "_office_available", lambda kind: False)
    monkeypatch.setattr(render, "_soffice", lambda: None)
    assert "[APO-FILE-310]" in render.export_pdf(tmp_path / "a.docx", tmp_path / "a.pdf", "docx")


# ---------------------------------------------------------------- 7. concise checks with citations

def test_check_is_concise_and_cited(subject, monkeypatch):
    now = time.time()
    nid = db.ex("INSERT INTO user_notes(subject_id, topic_id, title, html, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                (subject["sid"], subject["tid"], "My note", "<p>small.pdf says word1x3 word1x4 is wrong.</p>", now, now))
    rid = db.ex("INSERT INTO reviews(subject_id, target, target_id, mode, status, created_at, updated_at) "
                "VALUES (?, 'note', ?, 'check', 'queued', ?, ?)", (subject["sid"], nid, now, now))
    seen = {}

    def fake(messages, schema, **kw):
        seen["system"], seen["task"] = messages[0]["content"], messages[-1]["content"]
        return review.Check(verdict="incorrect", summary="One. Two. Three. " * 40, issues=[
            review.Issue(quote="is wrong", problem="It's wrong.", fix="is right", source="small.pdf · Page 1")] * 9)
    monkeypatch.setattr(review.llm, "chat_json", fake)
    review.run_review(rid, _Job())
    res = json.loads(db.q1("SELECT result FROM reviews WHERE id=?", (rid,))["result"])
    assert len(res["issues"]) == review.MAX_ISSUES and res["issues"][0]["source"] == "[[small.pdf · Page 1]]"
    assert len(res["summary"]) < 100
    assert "at most 6" in seen["task"] and "at most" not in seen["system"].split("=== STUDY MATERIAL")[0].replace(
        review.CHECK_RULES.replace("{scope}", ""), "")
    assert seen["system"].startswith(review.CHECK_RULES.split("{scope}")[0])  # the cached rules are unchanged
