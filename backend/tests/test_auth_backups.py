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


def test_migrations_run_once_and_record_the_version(fresh_conn):
    db._migrate(fresh=True)
    assert _version(fresh_conn) == db.SCHEMA_VERSION and not db.list_backups()  # nothing to back up yet
    cols = [r[1] for r in fresh_conn.execute("PRAGMA table_info(documents)")]
    assert "render_map" in cols and "vision_indexed" in cols
    # an old database (every legacy column there, version never recorded) opens fine and is backed up first
    fresh_conn.execute("PRAGMA user_version = 0")
    db._migrate(fresh=False)
    assert _version(fresh_conn) == db.SCHEMA_VERSION and [b["kind"] for b in db.list_backups()] == ["before-update"]


def test_a_failing_migration_stops_start_up(fresh_conn, monkeypatch):
    db._migrate(fresh=True)
    monkeypatch.setattr(db, "MIGRATIONS", [(2, ["ALTER TABLE documents ADD COLUMN ok_col TEXT", "ALTER TABLE nosuch ADD x"])])
    monkeypatch.setattr(db, "SCHEMA_VERSION", 2)
    with pytest.raises(db.StartupError, match="version 2"):
        db._migrate(fresh=False)
    # rolled back as a whole, version unchanged, and a backup was made before trying
    assert _version(fresh_conn) == 1 and "ok_col" not in [r[1] for r in fresh_conn.execute("PRAGMA table_info(documents)")]
    assert [b["kind"] for b in db.list_backups()] == ["before-update"]


def test_a_legacy_failure_is_not_mistaken_for_already_applied(fresh_conn, monkeypatch):
    monkeypatch.setattr(db, "LEGACY_MIGRATIONS", [*db.LEGACY_MIGRATIONS, "ALTER TABLE missing_table ADD COLUMN x TEXT"])
    with pytest.raises(db.StartupError):
        db._migrate(fresh=True)


def test_data_from_a_newer_app_is_refused(fresh_conn):
    fresh_conn.execute("PRAGMA user_version = 999")
    with pytest.raises(db.StartupError, match="newer version"):
        db._migrate(fresh=False)
