"""The backend token, database backups and restore, and versioned migrations."""
import sqlite3

import pytest
from fastapi.testclient import TestClient

from studyapp import config, db
from studyapp.api import app

client = TestClient(app)


@pytest.fixture
def token(monkeypatch):
    monkeypatch.setattr(config, "API_TOKEN", "s3cret-token")
    return "s3cret-token"


def test_requests_need_the_token(token):
    assert client.get("/health").status_code == 200  # Electron's start-up check
    assert client.get("/subjects").status_code == 401
    assert client.get("/subjects", headers={"X-Apollo-Token": "wrong"}).status_code == 401
    assert client.get("/subjects", headers={"X-Apollo-Token": token}).status_code == 200
    # media URLs (img, pdf.js) carry it in the query; only for GETs
    assert client.get(f"/subjects?token={token}").status_code == 200
    assert client.post(f"/jobs/pause?token={token}", json={}).status_code == 401
    assert client.post("/jobs/pause", json={}, headers={"X-Apollo-Token": token}).status_code == 200


def test_a_web_page_gets_nothing_without_the_token(token):
    # a sandboxed iframe on any site sends Origin: null, like the packaged app's file:// page
    pre = client.options("/subjects", headers={"Origin": "null", "Access-Control-Request-Method": "POST",
                                               "Access-Control-Request-Headers": "x-apollo-token"})
    assert pre.status_code == 200
    r = client.post("/documents", json={"paths": ["C:/Windows/win.ini"], "subject_id": 1}, headers={"Origin": "null"})
    assert r.status_code == 401 and r.headers.get("access-control-allow-origin") == "null"  # the UI can read why
    assert client.get("/subjects", headers={"Origin": "https://evil.example"}).status_code == 401
    assert "access-control-allow-origin" not in client.options(
        "/subjects", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"}).headers


def test_no_token_configured_leaves_tests_and_tools_open():
    assert config.API_TOKEN is None and client.get("/subjects").status_code == 200


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    """A separate data folder whose study.db holds one row, so backups and restores don't touch the session db."""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    c = sqlite3.connect(tmp_path / "study.db")
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("CREATE TABLE t (v TEXT)")
    c.execute("INSERT INTO t VALUES ('original')")
    c.commit()
    yield c
    c.close()


def _value(path):
    c = sqlite3.connect(path)
    try:
        return c.execute("SELECT v FROM t").fetchone()[0]
    finally:
        c.close()


def test_backup_is_a_consistent_copy_and_old_ones_are_pruned(scratch):
    b = db.backup("manual")
    assert _value(config.backups_dir() / b["name"]) == "original" and b["kind"] == "manual"
    for _ in range(db.KEEP["daily"] + 2):
        db.backup("daily")
    kinds = [x["kind"] for x in db.list_backups()]
    assert kinds.count("daily") == db.KEEP["daily"] and kinds.count("manual") == 1
    with pytest.raises(ValueError):
        db.backup("weird")


def test_restore_happens_at_next_start_and_keeps_current_data(scratch, client_names=None):
    name = db.backup("manual")["name"]
    scratch.execute("UPDATE t SET v='changed'")
    scratch.commit()
    db.request_restore(name)
    assert db.pending_restore() == name
    scratch.close()
    db._apply_pending_restore()
    assert _value(config.db_path()) == "original" and db.pending_restore() is None
    saved = [b for b in db.list_backups() if b["kind"] == "before-restore"]
    assert len(saved) == 1 and _value(config.backups_dir() / saved[0]["name"]) == "changed"
    with pytest.raises(ValueError):
        db.request_restore("../study.db")


def test_backup_endpoints(scratch):
    made = client.post("/backups").json()
    assert [b["name"] for b in client.get("/backups").json()["backups"]] == [made["name"]]
    assert client.post("/backups/restore", json={"name": made["name"]}).json()["pending_restore"] == made["name"]
    assert client.post("/backups/restore", json={"name": None}).json()["pending_restore"] is None
    assert client.delete("/backups/nope.db").status_code == 404
    assert client.delete(f"/backups/{made['name']}").status_code == 200 and not db.list_backups()


@pytest.fixture
def fresh_conn(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    c = sqlite3.connect(tmp_path / "study.db", check_same_thread=False, isolation_level=None)
    monkeypatch.setattr(db, "_conn", c)
    yield c
    c.close()


def _version(c):
    return c.execute("PRAGMA user_version").fetchone()[0]


def test_migrations_run_once_and_record_the_version(fresh_conn, monkeypatch):
    db._migrate(fresh=True)
    assert _version(fresh_conn) == db.SCHEMA_VERSION and not db.list_backups()  # nothing to back up yet
    cols = [r[1] for r in fresh_conn.execute("PRAGMA table_info(documents)")]
    assert "render_map" in cols and "vision_indexed" in cols
    assert "vec_version" in cols and fresh_conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'chunks_vec_%'").fetchone()[0] == 3


def test_an_old_database_opens_and_is_backed_up_first(fresh_conn, monkeypatch):
    # every legacy column there but the version never recorded (databases from before versioning)
    migrations, version = db.MIGRATIONS, db.SCHEMA_VERSION
    monkeypatch.setattr(db, "MIGRATIONS", [])
    monkeypatch.setattr(db, "SCHEMA_VERSION", db.LEGACY_VERSION)
    db._migrate(fresh=True)
    fresh_conn.execute("PRAGMA user_version = 0")
    monkeypatch.setattr(db, "MIGRATIONS", migrations)
    monkeypatch.setattr(db, "SCHEMA_VERSION", version)
    db._migrate(fresh=False)
    assert _version(fresh_conn) == db.SCHEMA_VERSION and [b["kind"] for b in db.list_backups()] == ["before-update"]


def test_a_failing_migration_stops_start_up(fresh_conn, monkeypatch):
    db._migrate(fresh=True)
    v = db.SCHEMA_VERSION
    monkeypatch.setattr(db, "MIGRATIONS", [*db.MIGRATIONS, (v + 1, ["ALTER TABLE documents ADD COLUMN ok_col TEXT", "ALTER TABLE nosuch ADD x"])])
    monkeypatch.setattr(db, "SCHEMA_VERSION", v + 1)
    with pytest.raises(db.StartupError, match=f"version {v + 1}"):
        db._migrate(fresh=False)
    # rolled back as a whole, version unchanged, and a backup was made before trying
    assert _version(fresh_conn) == v and "ok_col" not in [r[1] for r in fresh_conn.execute("PRAGMA table_info(documents)")]
    assert [b["kind"] for b in db.list_backups()] == ["before-update"]


def test_a_legacy_failure_is_not_mistaken_for_already_applied(fresh_conn, monkeypatch):
    monkeypatch.setattr(db, "LEGACY_MIGRATIONS", [*db.LEGACY_MIGRATIONS, "ALTER TABLE missing_table ADD COLUMN x TEXT"])
    with pytest.raises(db.StartupError):
        db._migrate(fresh=True)


def test_data_from_a_newer_app_is_refused(fresh_conn):
    fresh_conn.execute("PRAGMA user_version = 999")
    with pytest.raises(db.StartupError, match="newer version"):
        db._migrate(fresh=False)


# ---------------------------------------------------------------- path grants (grants.py)

import base64  # noqa: E402
import json  # noqa: E402

from studyapp import grants  # noqa: E402


def _header(**paths_modes):
    raw = {p: grants.sign(p, mode) for p, mode in paths_modes.values()}
    return {"X-Apollo-Grants": base64.urlsafe_b64encode(json.dumps(raw).encode()).decode().rstrip("=")}


@pytest.fixture
def grant_key(monkeypatch):
    monkeypatch.setattr(grants, "KEY", "test-grant-key")


def test_reading_a_file_needs_a_grant(grant_key, tmp_path):
    f = tmp_path / "notes.txt"
    f.write_text("hello")
    sid = db.ex("INSERT INTO subjects(name, created_at) VALUES ('Grants', 0)")
    try:
        r = client.post("/documents", json={"paths": [str(f)], "subject_id": sid})
        assert r.status_code == 403 and "file picker" in r.json()["detail"]
        # a grant for another file, or for writing, doesn't count
        other = _header(a=(str(tmp_path / "other.txt"), "read"), b=(str(f), "write"))
        assert client.post("/documents", json={"paths": [str(f)], "subject_id": sid}, headers=other).status_code == 403
        ok = client.post("/documents", json={"paths": [str(f)], "subject_id": sid}, headers=_header(a=(str(f), "read")))
        assert ok.status_code == 200 and ok.json()[0]["status"] == "queued"
        # the grant matches however the path is spelled (case, slashes)
        loose = str(f).upper().replace("\\", "/")
        r = client.post("/chat-files/inspect", json={"paths": [loose]}, headers=_header(a=(str(f), "read")))
        assert r.json()[0]["ok"], r.json()
    finally:
        for d in db.q("SELECT id FROM documents WHERE subject_id=?", (sid,)):
            client.delete(f"/documents/{d['id']}")
        db.ex("DELETE FROM jobs")
        db.ex("DELETE FROM subjects WHERE id=?", (sid,))


def test_writing_needs_a_write_grant_and_data_folder_reads_are_free(grant_key, tmp_path):
    out = str(tmp_path / "pack.zip")
    assert client.post("/export", json={"subject_id": 1, "path": out}).status_code == 403
    assert client.post("/export", json={"subject_id": 1, "path": out}, headers=_header(a=(out, "read"))).status_code == 403
    assert client.post("/export", json={"subject_id": -1, "path": out}, headers=_header(a=(out, "write"))).status_code == 404
    # files the app keeps itself (e.g. chat screenshots) are readable without a grant
    inside = config.assets_dir() / "chat" / "shot.png"
    inside.parent.mkdir(parents=True, exist_ok=True)
    inside.write_bytes(b"x")
    assert grants.require(str(inside)) == inside
    with pytest.raises(Exception):
        grants.require(str(inside), "write")


# ---------------------------------------------------------------- API keys at rest (secret_store.py)

def test_api_keys_are_encrypted_in_the_database(settings):
    settings(openrouter_api_key="sk-or-secret-value")
    raw = json.loads(db.q1("SELECT value FROM settings WHERE key='openrouter_api_key'")["value"])
    assert raw.startswith("dpapi:") and "secret-value" not in raw
    assert db.setting("openrouter_api_key") == "sk-or-secret-value"
    assert db.get_settings()["openrouter_api_key"] == "sk-or-secret-value"
    assert client.get("/settings").json()["openrouter_api_key"] == "••••••••"  # the UI only learns one is set
