"""SQLite storage: relational data, FTS5 keyword index, embeddings as float32 BLOBs."""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

from . import config

SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#7c8cff',
    created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL
);
-- kind: 'topic' (topic_id set) or 'reference' (subject-level textbook; topic_id NULL)
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, kind TEXT NOT NULL,
    filename TEXT NOT NULL, ext TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
    status TEXT NOT NULL, error TEXT, vision_mode TEXT NOT NULL,
    unit_count INTEGER DEFAULT 0, token_count INTEGER DEFAULT 0, chunk_count INTEGER DEFAULT 0,
    duplicate_units INTEGER DEFAULT 0, stripped_lines INTEGER DEFAULT 0,
    vision_total INTEGER DEFAULT 0, vision_done INTEGER DEFAULT 0,
    parser_version TEXT, embed_model TEXT, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL,
    content_hash TEXT NOT NULL, duplicate_of INTEGER, token_count INTEGER NOT NULL,
    equations INTEGER DEFAULT 0, images TEXT NOT NULL DEFAULT '[]', vision_image TEXT,
    needs_vision INTEGER NOT NULL DEFAULT 0, vision_reasons TEXT NOT NULL DEFAULT '[]',
    vision_status TEXT NOT NULL DEFAULT 'none', vision_notes TEXT, vision_relevant INTEGER
);
CREATE INDEX IF NOT EXISTS units_doc ON units(document_id, idx);
CREATE INDEX IF NOT EXISTS units_hash ON units(content_hash);
CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    unit_start INTEGER NOT NULL, unit_end INTEGER NOT NULL, label TEXT NOT NULL,
    text TEXT NOT NULL, token_count INTEGER NOT NULL, embedding BLOB, embed_model TEXT
);
CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY, type TEXT NOT NULL, document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
    error TEXT, cancel INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, type);
CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, title TEXT NOT NULL DEFAULT 'New chat',
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
-- role: user | assistant | tool (a create-content form / artifact card; details in meta JSON)
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
-- Generated content: flashcards | quiz | exam | notes | cheatsheet
CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
    type TEXT NOT NULL, title TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}', content TEXT,
    status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', error TEXT,
    created_at REAL NOT NULL, updated_at REAL NOT NULL
);
-- Practice exams are never embedded; only their structure is used.
CREATE TABLE IF NOT EXISTS practice_exams (
    id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL, sha256 TEXT NOT NULL, text TEXT NOT NULL, blueprint TEXT, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY, artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    answers TEXT NOT NULL, status TEXT NOT NULL, result TEXT, score REAL, total REAL,
    progress REAL NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL
);
"""

MIGRATIONS = [
    "ALTER TABLE jobs ADD COLUMN ref_id INTEGER",  # artifact id (generate) or attempt id (mark)
    # Subject icon in the mini sidebar: initials text, or an emoji, or an uploaded image (asset path)
    "ALTER TABLE subjects ADD COLUMN icon_text TEXT",
    "ALTER TABLE subjects ADD COLUMN icon_emoji TEXT",
    "ALTER TABLE subjects ADD COLUMN icon_image TEXT",
    "ALTER TABLE attempts ADD COLUMN kind TEXT NOT NULL DEFAULT 'exam'",  # exam | quiz
    """CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, text TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'manual', done INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL
    )""",
    # Flashcard self-ratings. 'struggling' cards are passed to the chat tutor as context.
    """CREATE TABLE IF NOT EXISTS card_ratings (
        artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE, card_index INTEGER NOT NULL,
        rating TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (artifact_id, card_index)
    )""",
    # The student's own marks on a document: highlight | note | ink | textbox. Positions are fractions of the unit's
    # (page/slide/section) box; text anchors are character offsets into the unit's rendered text (see SourceView).
    """CREATE TABLE IF NOT EXISTS annotations (
        id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        unit INTEGER NOT NULL, kind TEXT NOT NULL, anchor TEXT NOT NULL DEFAULT '{}', data TEXT NOT NULL DEFAULT '{}',
        created_at REAL NOT NULL, updated_at REAL NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS annotations_doc ON annotations(document_id, unit)",
    # annotated_at: last change to annotation text; annotations_ingested: the annotated_at the last ingest included.
    "ALTER TABLE documents ADD COLUMN annotated_at REAL",
    "ALTER TABLE documents ADD COLUMN annotations_ingested REAL",
    # Word only: where each section starts in the exact PDF copy, {unit idx: [page, y fraction]} (render.py)
    "ALTER TABLE documents ADD COLUMN render_map TEXT",
    # Cropped figures for notes/chat, keyed by sha256(file hash | unit | description) (figures.py)
    "CREATE TABLE IF NOT EXISTS figure_cache (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
    # Where each viewer screenshot came from, so a screenshot sent to the chat can jump back to its page and area
    "CREATE TABLE IF NOT EXISTS snapshots (path TEXT PRIMARY KEY, document_id INTEGER, unit INTEGER, rect TEXT NOT NULL, created_at REAL NOT NULL)",
    # Opaque UI state stored for the frontend and never read by the backend, e.g. 'folders:<subject id>' (file
    # folders inside topics, display only)
    "CREATE TABLE IF NOT EXISTS ui_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    # Finished jobs the student cleared from the jobs list
    "ALTER TABLE jobs ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0",
]

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None


def init():
    global _conn
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.files_dir().mkdir(exist_ok=True)
    config.assets_dir().mkdir(exist_ok=True)
    _conn = sqlite3.connect(config.db_path(), check_same_thread=False, isolation_level=None)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript(SCHEMA)
    for m in MIGRATIONS:
        try:
            _conn.execute(m)
        except sqlite3.OperationalError:
            pass  # already applied
    with tx() as c:
        for k, v in config.DEFAULT_SETTINGS.items():
            c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, json.dumps(v)))
        # Anything interrupted by a crash/quit goes back to the queue.
        c.execute("UPDATE jobs SET status='queued', updated_at=? WHERE status='running'", (time.time(),))


@contextmanager
def tx():
    with _lock:
        _conn.execute("BEGIN")
        try:
            yield _conn
            _conn.execute("COMMIT")
        except BaseException:
            _conn.execute("ROLLBACK")
            raise


def q(sql, args=()):
    with _lock:
        return [dict(r) for r in _conn.execute(sql, args).fetchall()]


def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def ex(sql, args=()):
    with _lock:
        return _conn.execute(sql, args).lastrowid


def get_settings() -> dict:
    return {r["key"]: json.loads(r["value"]) for r in q("SELECT key, value FROM settings")}


def setting(key):
    r = q1("SELECT value FROM settings WHERE key=?", (key,))
    return json.loads(r["value"]) if r else config.DEFAULT_SETTINGS.get(key)


def put_settings(values: dict):
    with tx() as c:
        for k, v in values.items():
            if k in config.DEFAULT_SETTINGS:
                c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, json.dumps(v)))
