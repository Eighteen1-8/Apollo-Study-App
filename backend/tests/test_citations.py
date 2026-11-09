"""Citations name one unit and point at the unit that says what the sentence before them says (citations.py)."""
import time

from studyapp import citations, db, pipeline


def _subject():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Cites', ?)", (now,))
    tid = db.ex("INSERT INTO topics(subject_id, name, created_at) VALUES (?, 'T', ?)", (sid, now))
    return sid, tid


def _doc(sid, tid, name, kind, units):
    now = time.time()
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, unit_count, "
                "token_count, created_at, updated_at) VALUES (?,?, 'topic', ?, ?, ?, 1, 'ready', 'off', ?, 100, ?, ?)",
                (sid, tid, name, "." + name.rsplit(".", 1)[1], f"sha-{name}-{now}", len(units), now, now))
    for i, (label, text) in enumerate(units, 1):
        db.ex("INSERT INTO units(document_id, idx, kind, label, text, content_hash, token_count) VALUES (?,?,?,?,?,?,20)",
              (did, i, kind, label, text, f"h-{did}-{i}"))
    return did


def test_word_sections_get_unique_names_and_are_found_again():
    u = {"idx": 14, "kind": "section", "label": "Answer: D"}
    assert citations.cite_label(u) == "Section 14 · Answer: D"
    assert citations.cite_label({"idx": 3, "kind": "slide", "label": "Slide 3 · Intro"}) == "Slide 3 · Intro"
    units = [{"idx": i, "kind": "page", "label": f"Page {i}"} for i in range(1, 15)]
    assert citations.find_unit(units, "Page 12")["idx"] == 12
    assert [x["idx"] for x in citations.candidates(units, "Page 11 – Page 12")] == [11, 12]
    assert citations.find_unit(units, "Page 3 (part 2)")["idx"] == 3


def test_verify_moves_a_wrong_slide_and_leaves_right_ones():
    sid, tid = _subject()
    try:
        _doc(sid, tid, "Waves.pptx", "slide", [
            ("Slide 1 · Title", "Waves and sound, an introduction for students"),
            ("Slide 2 · Wave speed", "The wave speed equals frequency multiplied by wavelength for every periodic wave"),
            ("Slide 3 · Amplitude", "Amplitude measures the maximum displacement of particles from their resting position"),
        ])
        right = "Amplitude measures the maximum displacement of particles from rest [[Waves.pptx · Slide 3]]."
        assert citations.verify(right, sid)[0] == right
        wrong = "The wave speed equals frequency multiplied by wavelength for periodic waves [[Waves.pptx · Slide 3]]."
        fixed, changes = citations.verify(wrong, sid)
        assert "[[Waves.pptx · Slide 2 · Wave speed]]" in fixed and len(changes) == 1
        vague = "Hello there [[Waves.pptx · Slide 1]]"  # too little to judge: left alone
        assert citations.verify(vague, sid)[0] == vague
    finally:
        for d in db.q("SELECT id FROM documents WHERE subject_id=?", (sid,)):
            pipeline.clear_document(d["id"])
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_repeated_word_headings_resolve_to_the_matching_section():
    sid, tid = _subject()
    try:
        _doc(sid, tid, "Exam.docx", "section", [
            ("Answer: D", "Copyright protects the expression of ideas, not the ideas themselves"),
            ("Answer: D", "A Gantt chart milestone is shown as a diamond with no duration"),
        ])
        text = "On a Gantt chart a milestone is a diamond shape with no duration bar [[Exam.docx · Answer: D]]."
        fixed, _ = citations.verify(text, sid)
        assert "[[Exam.docx · Section 2 · Answer: D]]" in fixed
    finally:
        for d in db.q("SELECT id FROM documents WHERE subject_id=?", (sid,)):
            pipeline.clear_document(d["id"])
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))
