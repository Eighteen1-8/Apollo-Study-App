"""The example subject: a small Physics course (three short lecture PDFs, made here, so nothing is downloaded) with
flashcards, a quiz, study notes, a chat and two to-dos already in it, so a new student can see how Apollo works before
adding their own files. It needs no model to be made: the files are read and chunked right away; their search vectors
are made by an `embed` job now if the embedding model answers, otherwise at a later start-up (embed_waiting); until
then search matches words only."""
import hashlib
import json
import logging
import time
from pathlib import Path

import pymupdf

from . import config, db, dedupe, jobs, llm
from .chunker import chunk_units
from .parsers import approx_tokens, parse

log = logging.getLogger(__name__)

NAME = "Physics (example)"
# the study sheet's chat-bar placeholder (other subjects get theirs from Apollo: questions.py)
QUESTIONS = ["What's the difference between speed and velocity?", "Why is kinetic energy ½mv²?",
             "How do wavelength and frequency relate?"]

LECTURES = [
    ("Motion", "Lecture 1 – Motion.pdf", [
        ("Describing motion", ["Kinematics describes how things move, without asking why.",
                               "We track position, how it changes (velocity) and how that changes (acceleration).",
                               "Every measurement needs a unit: metres (m), seconds (s), metres per second (m/s)."]),
        ("Distance and displacement", ["Distance is the total length of the path travelled: a scalar.",
                                       "Displacement is the straight-line change in position, with a direction: a vector.",
                                       "Walk 3 m east then 3 m west: distance 6 m, displacement 0 m."]),
        ("Speed and velocity", ["Speed = distance / time. It has size only.",
                                "Velocity = displacement / time. It has size and direction.",
                                "A car going round a bend at a steady 50 km/h has constant speed but changing velocity."]),
        ("Acceleration", ["Acceleration is the rate of change of velocity: a = (v - u) / t.",
                          "Units: metres per second squared (m/s^2).",
                          "Slowing down is acceleration too, in the direction opposite to the motion."]),
        ("Equations of motion", ["For constant acceleration: v = u + at,  s = ut + 1/2 at^2,  v^2 = u^2 + 2as.",
                                 "u is the starting velocity, v the final velocity, s the displacement, t the time.",
                                 "Pick the equation that leaves out the quantity you don't know and don't need."]),
    ]),
    ("Energy", "Lecture 2 – Energy.pdf", [
        ("Work", ["Work is done when a force moves something: W = F d cos(theta).",
                  "Measured in joules (J). 1 J = 1 N moving 1 m.",
                  "No movement in the direction of the force means no work is done."]),
        ("Kinetic energy", ["Kinetic energy is the energy of motion: KE = 1/2 m v^2.",
                            "Doubling the speed makes the kinetic energy four times larger.",
                            "Braking distance grows with KE, which is why speed matters so much for safety."]),
        ("Potential energy", ["Gravitational potential energy: PE = m g h, with g = 9.8 m/s^2 near Earth.",
                              "Only changes in height matter, so choose a convenient zero level."]),
        ("Conservation of energy", ["Energy is never created or destroyed, only changed from one form to another.",
                                    "A falling ball turns PE into KE: m g h = 1/2 m v^2, so v = sqrt(2 g h).",
                                    "Friction turns some energy into heat, so real systems seem to 'lose' energy."]),
    ]),
    ("Waves", "Lecture 3 – Waves.pdf", [
        ("What is a wave?", ["A wave carries energy from place to place without carrying matter with it.",
                             "Transverse waves vibrate across the direction of travel (light, waves on a string).",
                             "Longitudinal waves vibrate along it (sound)."]),
        ("Describing waves", ["Amplitude: the largest displacement from rest.",
                              "Wavelength (lambda): the length of one full cycle, in metres.",
                              "Frequency (f): cycles per second, in hertz (Hz). Period T = 1 / f."]),
        ("The wave equation", ["Wave speed v = f lambda.",
                               "Sound in air travels at about 343 m/s; light at 3.0 x 10^8 m/s.",
                               "If frequency doubles at the same speed, the wavelength halves."]),
        ("Interference", ["When waves meet they add: crests on crests make bigger waves (constructive).",
                          "Crests on troughs cancel (destructive): the idea behind noise-cancelling headphones.",
                          "Standing waves form when a wave and its reflection interfere, as on a guitar string."]),
    ]),
]

FLASHCARDS = [
    ("What is the difference between distance and displacement?",
     "Distance is the total path length (a scalar); displacement is the straight-line change in position with a direction (a vector).", 0, 2),
    ("What is the difference between speed and velocity?",
     "Speed has size only; velocity has size and direction. Steady speed round a bend still means changing velocity.", 0, 3),
    ("Write the formula for acceleration.", "$a = \\frac{v - u}{t}$, in m/s².", 0, 4),
    ("Which equation of motion has no time in it?", "$v^2 = u^2 + 2as$", 0, 5),
    ("What is the formula for kinetic energy?", "$KE = \\tfrac{1}{2} m v^2$: doubling the speed makes it four times larger.", 1, 2),
    ("What does conservation of energy say?", "Energy is never created or destroyed, only changed from one form to another.", 1, 4),
    ("What is the wave equation?", "$v = f\\lambda$: wave speed equals frequency times wavelength.", 2, 3),
    ("Transverse or longitudinal: sound?", "Longitudinal: the air vibrates along the direction the sound travels.", 2, 1),
]

QUIZ = [
    ("A runner goes once round a 400 m track and stops where they started. What is their displacement?",
     ["400 m", "200 m", "0 m", "It depends on their speed"], 2,
     "Displacement is the change in position, and they end where they began.", 0, 2),
    ("A ball is dropped from 5 m. Ignoring air resistance, about how fast is it going when it lands? (g = 9.8 m/s²)",
     ["About 5 m/s", "About 10 m/s", "About 49 m/s", "About 98 m/s"], 1,
     "Energy is conserved: $v = \\sqrt{2gh} = \\sqrt{2 \\times 9.8 \\times 5} \\approx 9.9$ m/s.", 1, 4),
    ("A wave has frequency 170 Hz and travels at 340 m/s. What is its wavelength?",
     ["0.5 m", "2 m", "57 800 m", "170 m"], 1, "$\\lambda = v / f = 340 / 170 = 2$ m.", 2, 3),
    ("If a car's speed doubles, its kinetic energy…", ["stays the same", "doubles", "triples", "becomes four times larger"], 3,
     "$KE = \\tfrac{1}{2}mv^2$, so it grows with the square of the speed.", 1, 2),
]

NOTES_HTML = """<h2>Waves in one page</h2>
<p>A <b>wave</b> carries energy without carrying matter. Two kinds:</p>
<ul><li><b>Transverse</b>: vibration across the direction of travel (light, a string).</li>
<li><b>Longitudinal</b>: vibration along it (sound).</li></ul>
<h3>Describing a wave</h3>
<table><tr><th>Quantity</th><th>Symbol</th><th>Unit</th></tr>
<tr><td>Amplitude</td><td>A</td><td>m</td></tr><tr><td>Wavelength</td><td>$\\lambda$</td><td>m</td></tr>
<tr><td>Frequency</td><td>$f$</td><td>Hz</td></tr><tr><td>Period</td><td>$T = 1/f$</td><td>s</td></tr></table>
<h3>The wave equation</h3>
<p>$$v = f\\lambda$$ At the same speed, doubling the frequency halves the wavelength.</p>
<h3>Interference</h3>
<p>Waves that meet add up: crest on crest is <b>constructive</b>, crest on trough is <b>destructive</b>. A wave and its
reflection make a <b>standing wave</b>.</p>"""


def _pdf(slides) -> bytes:
    """Slide-shaped pages: a title and a few points, real text so they're read like any lecture PDF."""
    d = pymupdf.open()
    for title, points in slides:
        p = d.new_page(width=960, height=540)
        p.insert_text((60, 95), title, fontsize=34)
        y = 175
        for point in points:
            # the bullet is drawn: the built-in PDF fonts only cover Latin-1, so "•" would come out as "?"
            p.draw_circle((76, y + 14), 4, color=(0.31, 0.36, 0.84), fill=(0.31, 0.36, 0.84))
            box = pymupdf.Rect(92, y, 900, y + 80)
            p.insert_textbox(box, point, fontsize=21)
            y += 82
    return d.tobytes()


def _add_file(sid: int, tid: int, filename: str, slides) -> int:
    """Store and read one file without any model: units, exact-duplicate check and chunks now, search vectors later."""
    data = _pdf(slides)
    sha = hashlib.sha256(data).hexdigest()
    path = config.files_dir() / f"{sha}.pdf"
    path.write_bytes(data)
    now = time.time()
    did = db.ex("INSERT INTO documents(subject_id, topic_id, kind, filename, ext, sha256, size, status, vision_mode, created_at, updated_at) "
                "VALUES (?,?,'topic',?,'.pdf',?,?,'parsing','off',?,?)", (sid, tid, filename, sha, len(data), now, now))
    s = db.get_settings()
    units, meta = parse(path, config.assets_dir() / str(did), s)
    with db.tx() as c:
        for u in units:
            c.execute("INSERT INTO units(document_id, idx, kind, label, text, content_hash, duplicate_of, token_count, equations, images, "
                      "needs_vision, vision_reasons, vision_status) VALUES (?,?,?,?,?,?,NULL,?,?,?,0,'[]','none')",
                      (did, u["idx"], u["kind"], u["label"], u["text"], dedupe.content_hash(u["text"], u["image_hashes"]),
                       approx_tokens(u["text"]), u["equations"], json.dumps(u["images"])))
    chunks = chunk_units(units, int(s["chunk_target_tokens"]), int(s["chunk_max_slides"]))
    with db.tx() as c:
        for ch in chunks:
            cid = c.execute("INSERT INTO chunks(document_id, unit_start, unit_end, label, text, token_count) VALUES (?,?,?,?,?,?)",
                            (did, ch["unit_start"], ch["unit_end"], ch["label"], ch["text"], ch["token_count"])).lastrowid
            c.execute("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)", (cid, ch["text"]))
    from .pipeline import PARSER_VERSION
    db.ex("UPDATE documents SET status='ready', unit_count=?, token_count=?, chunk_count=?, stripped_lines=?, parser_version=?, "
          "vision_indexed=1, updated_at=? WHERE id=?",
          (len(units), sum(approx_tokens(u["text"]) for u in units), len(chunks), meta.get("stripped_lines", 0), PARSER_VERSION,
           time.time(), did))
    if llm.model_status()["embed"]["ok"]:  # otherwise embed_waiting() makes them once the model can be reached
        jobs.enqueue("embed", did)
    return did


def embed_waiting() -> int:
    """At start-up: files that were read but never got their search vectors (the example made while the embedding
    model was off) get an `embed` job, if that model answers now. Returns how many were queued."""
    rows = db.q("""SELECT DISTINCT c.document_id FROM chunks c JOIN documents d ON d.id=c.document_id
                   WHERE c.embedding IS NULL AND d.status='ready' AND d.kind<>'trash'
                   AND c.document_id NOT IN (SELECT document_id FROM jobs WHERE document_id IS NOT NULL
                                             AND status IN ('queued','running'))""")
    if not rows or not llm.model_status()["embed"]["ok"]:
        return 0
    for r in rows:
        jobs.enqueue("embed", r["document_id"])
    return len(rows)


def create() -> dict:
    """Make the example subject (or return the one already made)."""
    old = db.q1("SELECT id FROM subjects WHERE name=?", (NAME,))
    if old:
        return {"id": old["id"], "created": False}
    now = time.time()
    # icon_name: subject art from app/src/components/subjectIcons.ts
    sid = db.ex("INSERT INTO subjects(name, color, icon_name, questions, created_at) VALUES (?,?,?,?,?)",
                (NAME, "#8b9bff", "comet", json.dumps(QUESTIONS), now))
    topics, files = {}, {}
    for i, (topic, filename, slides) in enumerate(LECTURES):
        topics[i] = db.ex("INSERT INTO topics(subject_id, name, description, created_at, position) VALUES (?,?,?,?,?)",
                          (sid, topic, "", now, i))
        files[i] = (filename, _add_file(sid, topics[i], filename, slides))
    src = lambda lec, page: f"{files[lec][0]} · Page {page}"  # noqa: E731

    def artifact(kind, title, topic, content, ago):
        db.ex("INSERT INTO artifacts(subject_id, topic_id, type, title, params, content, status, progress, message, created_at, updated_at) "
              "VALUES (?,?,?,?,?,?,'ready',1,'Ready',?,?)", (sid, topic, kind, title, json.dumps({"example": True}),
                                                           json.dumps(content), now - ago, now - ago))

    artifact("flashcards", "Flashcards: Physics basics", None,
             {"cards": [{"front": f, "back": b, "source": src(lec, pg)} for f, b, lec, pg in FLASHCARDS]}, 300)
    artifact("quiz", "Quiz: Physics check-up", None,
             {"questions": [{"question": q, "options": o, "answer_index": a, "explanation": e, "source": src(lec, pg)}
                            for q, o, a, e, lec, pg in QUIZ]}, 200)
    artifact("notes", "Notes: Waves", topics[2],
             {"sections": [{"title": "Waves in one page", "topic": "Waves", "html": NOTES_HTML, "figures": []}]}, 100)

    cid = db.ex("INSERT INTO chats(subject_id, title, created_at, updated_at) VALUES (?,?,?,?)",
                (sid, "Speed vs velocity (example)", now - 60, now - 60))
    for role, text in [
        ("user", "What's the difference between speed and velocity?"),
        ("assistant", "**Speed** is how fast something moves: just a size, like 50 km/h. **Velocity** is speed *with a "
                      f"direction*, like 50 km/h north [[{src(0, 3)}]].\n\nSo a car going round a bend at a steady 50 km/h "
                      "keeps the same speed, but its velocity keeps changing, because its direction does. That change in "
                      f"velocity is an acceleration, even though the speedometer doesn't move [[{src(0, 4)}]].\n\n"
                      "Want me to quiz you on this, or make a few flashcards?"),
    ]:
        db.ex("INSERT INTO messages(chat_id, role, content, meta, created_at) VALUES (?,?,?,?,?)", (cid, role, text, "{}", now - 60))
    for i, (text, done) in enumerate([("Try the example flashcards", 0), ("Ask Apollo something about waves", 0)]):
        db.ex("INSERT INTO todos(subject_id, text, note, source, done, created_at, position) VALUES (?,?,?,?,?,?,?)",
              (sid, text, "", "manual", done, now, i))
    log.info("example subject made (id %s)", sid)
    return {"id": sid, "created": True}
