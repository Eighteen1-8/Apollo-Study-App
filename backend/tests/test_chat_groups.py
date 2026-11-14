"""Chat groups: folders the student sorts a subject's chats into (chats.py). Deleting a group never deletes chats."""
import sqlite3
import time

from fastapi.testclient import TestClient

from studyapp import chat_api, db
from studyapp.api import app

client = TestClient(app)


def _subject(name):
    return db.ex("INSERT INTO subjects(name, created_at) VALUES (?, ?)", (name, time.time()))


def _chat(sid, title):
    now = time.time()
    return db.ex("INSERT INTO chats(subject_id, title, created_at, updated_at) VALUES (?,?,?,?)", (sid, title, now, now))


def _groups_of(sid):
    return {c["id"]: c["group_id"] for c in client.get(f"/subjects/{sid}/chats").json()}


def test_migration_adds_the_table_and_column():
    cols = {r["name"] for r in db.q("PRAGMA table_info(chats)")}
    assert "group_id" in cols
    gcols = {r["name"] for r in db.q("PRAGMA table_info(chat_groups)")}
    assert {"id", "subject_id", "name", "position", "created_at", "deleted_at", "deleted_chats"} <= gcols
    assert db.q1("PRAGMA user_version")["user_version"] >= 15


def test_migration_runs_on_an_older_database(tmp_path):
    """The statements of migration 15 apply to a database from before it (chats without group_id)."""
    stmts = dict(db.MIGRATIONS)[15]
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.execute("CREATE TABLE subjects (id INTEGER PRIMARY KEY, name TEXT)")
    conn.execute("CREATE TABLE chats (id INTEGER PRIMARY KEY, subject_id INTEGER, title TEXT)")
    conn.execute("INSERT INTO chats(subject_id, title) VALUES (1, 'old')")
    for s in stmts:
        conn.execute(s)
    assert conn.execute("SELECT group_id FROM chats").fetchone() == (None,)
    conn.close()


def test_create_rename_move_order_and_list():
    sid = _subject("Grouped chats")
    try:
        a, b, c = _chat(sid, "A"), _chat(sid, "B"), _chat(sid, "C")
        before = db.q1("SELECT updated_at FROM chats WHERE id=?", (a,))["updated_at"]
        g1 = client.post(f"/subjects/{sid}/chat-groups", json={"name": " Exams ", "chat_ids": [a]}).json()
        assert g1["name"] == "Exams" and g1["subject_id"] == sid
        g2 = client.post(f"/subjects/{sid}/chat-groups", json={"name": "Labs"}).json()
        assert client.post(f"/subjects/{sid}/chat-groups", json={"name": "  "}).status_code == 400
        assert _groups_of(sid) == {a: g1["id"], b: None, c: None}
        # moving in and out keeps the chats' place in time
        assert client.post("/chats/group", json={"ids": [b, c], "group_id": g2["id"]}).status_code == 200
        assert _groups_of(sid) == {a: g1["id"], b: g2["id"], c: g2["id"]}
        client.post("/chats/group", json={"ids": [c], "group_id": None})
        assert _groups_of(sid)[c] is None
        assert db.q1("SELECT updated_at FROM chats WHERE id=?", (a,))["updated_at"] == before
        # rename and reorder
        assert client.patch(f"/chat-groups/{g1['id']}", json={"name": "Finals"}).json()["name"] == "Finals"
        assert [g["id"] for g in client.get(f"/subjects/{sid}/chat-groups").json()] == [g1["id"], g2["id"]]
        client.put(f"/subjects/{sid}/chat-groups/order", json={"ids": [g2["id"], g1["id"]]})
        listed = client.get(f"/subjects/{sid}/chat-groups").json()
        assert [g["id"] for g in listed] == [g2["id"], g1["id"]] and listed[1]["name"] == "Finals"
        # a group of another subject can't take this subject's chats
        other = _subject("Other")
        try:
            g3 = client.post(f"/subjects/{other}/chat-groups", json={"name": "Elsewhere"}).json()
            client.post("/chats/group", json={"ids": [c], "group_id": g3["id"]})
            assert _groups_of(sid)[c] is None
        finally:
            db.ex("DELETE FROM subjects WHERE id=?", (other,))
        assert client.post("/chats/group", json={"ids": [c], "group_id": 999999}).status_code == 404
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_delete_moves_chats_out_and_restore_puts_them_back():
    sid = _subject("Delete group")
    try:
        a, b, c = _chat(sid, "A"), _chat(sid, "B"), _chat(sid, "C")
        g = client.post(f"/subjects/{sid}/chat-groups", json={"name": "Week 1", "chat_ids": [a, b, c]}).json()
        # a soft-deleted chat keeps its group, and is back in it when restored
        client.post("/chats/delete", json={"ids": [c]})
        client.post("/chats/restore", json={"ids": [c]})
        assert _groups_of(sid)[c] == g["id"]
        client.post("/chats/delete", json={"ids": [c]})
        r = client.delete(f"/chat-groups/{g['id']}").json()
        assert sorted(r["chat_ids"]) == sorted([a, b, c])
        assert client.get(f"/subjects/{sid}/chat-groups").json() == []
        assert _groups_of(sid) == {a: None, b: None}  # the chats are all still there, ungrouped
        assert client.patch(f"/chat-groups/{g['id']}", json={"name": "x"}).status_code == 404
        # one chat is put elsewhere meanwhile: restoring the group leaves it there
        g2 = client.post(f"/subjects/{sid}/chat-groups", json={"name": "Other"}).json()
        client.post("/chats/group", json={"ids": [b], "group_id": g2["id"]})
        assert client.post(f"/chat-groups/{g['id']}/restore").json()["name"] == "Week 1"
        assert _groups_of(sid) == {a: g["id"], b: g2["id"]}
        client.post("/chats/restore", json={"ids": [c]})
        assert _groups_of(sid)[c] == g["id"]
        # purged a week after deletion; the chats stay
        client.delete(f"/chat-groups/{g2['id']}")
        db.ex("UPDATE chat_groups SET deleted_at=? WHERE id=?", (time.time() - 8 * 86400, g2["id"]))
        chat_api.purge_deleted_chats()
        assert db.q1("SELECT id FROM chat_groups WHERE id=?", (g2["id"],)) is None
        assert db.q1("SELECT id FROM chats WHERE id=?", (b,)) is not None
    finally:
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_deleting_the_subject_removes_its_groups():
    sid = _subject("Gone")
    g = client.post(f"/subjects/{sid}/chat-groups", json={"name": "G", "chat_ids": [_chat(sid, "A")]}).json()
    assert client.delete(f"/subjects/{sid}").status_code == 200
    assert db.q1("SELECT id FROM chat_groups WHERE id=?", (g["id"],)) is None
