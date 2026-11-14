"""Deleting flashcards (ratings follow the cards that stay) and dismissing finished jobs."""
import json
import time

from fastapi.testclient import TestClient

from studyapp import db
from studyapp.api import app


def test_delete_cards_renumbers_ratings():
    now = time.time()
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Cards', ?)", (now,))
    cards = [{"front": f"q{i}", "back": f"a{i}"} for i in range(4)]
    aid = db.ex("INSERT INTO artifacts(subject_id, type, title, content, status, created_at, updated_at) "
                "VALUES (?, 'flashcards', 'Deck', ?, 'ready', ?, ?)", (sid, json.dumps({"cards": cards}), now, now))
    c = TestClient(app)
    try:
        c.put(f"/artifacts/{aid}/cards/1/rating", json={"rating": "struggling"})
        c.put(f"/artifacts/{aid}/cards/3/rating", json={"rating": "confident"})
        r = c.post(f"/artifacts/{aid}/cards/delete", json={"indices": [0, 2, 99]})
        assert r.json()["count"] == 2
        left = json.loads(db.q1("SELECT content FROM artifacts WHERE id=?", (aid,))["content"])["cards"]
        assert [x["front"] for x in left] == ["q1", "q3"]
        ratings = {r["card_index"]: r["rating"] for r in db.q("SELECT * FROM card_ratings WHERE artifact_id=?", (aid,))}
        assert ratings == {0: "struggling", 1: "confident"}
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_dismiss_only_finished_jobs():
    now = time.time()
    done = db.ex("INSERT INTO jobs(type, status, created_at, updated_at) VALUES ('ingest', 'done', ?, ?)", (now, now))
    live = db.ex("INSERT INTO jobs(type, status, created_at, updated_at) VALUES ('ingest', 'queued', ?, ?)", (now, now))
    c = TestClient(app)
    try:
        c.post("/jobs/dismiss")
        ids = {j["id"] for j in c.get("/jobs").json()}
        assert done not in ids and live in ids
    finally:
        db.ex("DELETE FROM jobs WHERE id IN (?, ?)", (done, live))


def test_change_stream_names_what_changed():
    import time as _t
    from studyapp import db as _db, events
    events.start()
    _t.sleep(events.INTERVAL * 2)  # let the watcher take its first signatures
    stream = events._stream()
    assert next(stream).startswith("retry:")
    sid = _db.ex("INSERT INTO subjects(name, created_at) VALUES ('Events', 0)")
    try:
        _db.ex("INSERT INTO todos(subject_id, text, created_at) VALUES (?, 'revise', 0)", (sid,))
        # other tests' background work (a chat being titled) can change things too: look at the next few events
        seen = set()
        for _ in range(6):
            msg = next(stream)
            if msg.startswith("data: "):
                seen |= set(__import__("json").loads(msg[6:]))
                if {"subjects", "todos"} & seen:
                    break
        assert {"subjects", "todos"} & seen
    finally:
        _db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def _png(w=64, h=64, color=(200, 30, 30, 255)) -> bytes:
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, "PNG")
    return buf.getvalue()


def test_cropped_icon_upload_replaces_and_deletes_the_old_one():
    import base64
    from studyapp import config
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Icons', ?)", (time.time(),))
    c = TestClient(app)
    try:
        b64 = lambda raw: base64.b64encode(raw).decode()  # noqa: E731
        first = c.patch(f"/subjects/{sid}/icon", json={"image_png": b64(_png())}).json()["icon_image"]
        assert first.startswith("subject_icons/") and first.endswith(".png") and (config.assets_dir() / first).is_file()
        second = c.patch(f"/subjects/{sid}/icon", json={"image_png": b64(_png(color=(0, 0, 255, 255)))}).json()["icon_image"]
        assert second != first and (config.assets_dir() / second).is_file()
        assert not (config.assets_dir() / first).exists()  # the replaced picture isn't left behind
        # a colour change keeps the picture; choosing art clears it and deletes the file
        assert c.patch(f"/subjects/{sid}/icon", json={"color": "#123456"}).json()["icon_image"] == second
        assert c.patch(f"/subjects/{sid}/icon", json={"icon_name": "atom"}).json()["icon_image"] is None
        assert not (config.assets_dir() / second).exists()
        # only real PNGs of icon size
        for bad in (b64(b"\x89PNG not really"), b64(b"GIF89a....."), "not base64!", b64(_png(2000, 2000))):
            assert c.patch(f"/subjects/{sid}/icon", json={"image_png": bad}).status_code == 400
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_images_go_to_the_model_as_their_real_type():
    import io
    from PIL import Image
    from studyapp import llm

    def encoded(fmt, size=(40, 30), mode="RGB"):
        buf = io.BytesIO()
        Image.new(mode, size, "white").save(buf, fmt)
        return buf.getvalue()

    png, jpeg = encoded("PNG"), encoded("JPEG")
    assert llm.image_mime(png) == "image/png" and llm.image_mime(jpeg) == "image/jpeg"
    assert llm.image_mime(encoded("WEBP")) == "image/webp" and llm.image_mime(encoded("GIF", mode="P")) == "image/gif"
    assert llm.image_mime(encoded("BMP")) == "image/bmp" and llm.image_mime(encoded("TIFF")) == "image/tiff"
    assert llm.model_image(png) == (png, "image/png") and llm.model_image(jpeg) == (jpeg, "image/jpeg")
    for fmt, mode in (("WEBP", "RGB"), ("GIF", "P"), ("BMP", "RGB"), ("TIFF", "RGB")):
        data, mime = llm.model_image(encoded(fmt, mode=mode))
        assert mime == "image/png" and data.startswith(b"\x89PNG")
    assert llm.image_part(encoded("WEBP"))["image_url"]["url"].startswith("data:image/png;base64,")
    photo, mime = llm.model_image(encoded("JPEG", size=(4000, 3000)), max_side=2048)
    assert mime == "image/jpeg"
    with Image.open(io.BytesIO(photo)) as im:
        assert im.size == (2048, 1536)


def test_revise_sends_placeholders_not_pictures():
    from studyapp import review
    pic = "data:image/png;base64," + "iVBORw0KGgo" + "A" * 5000
    html = f'<p>Before</p><img src="{pic}"><p>Middle</p><img src="{pic}">'
    shown, images = review.hide_images(html)
    assert "base64" not in shown and shown.count("apollo-image:") == 2 and len(shown) < 200
    revised = shown.replace("Middle", "Changed")
    assert review.restore_images(revised, images) == html.replace("Middle", "Changed")
    assert review.restore_images('<img src="apollo-image:9">', images) == '<img src="apollo-image:9">'
