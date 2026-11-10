"""SQLite storage: relational data, FTS5 keyword index, embeddings as float32 BLOBs.

Connections: one writer (`_conn`, every write and every `tx()` under `_lock`) and one read-only connection per thread
for `q`/`q1`. The database is in WAL mode, so reads never wait for a write (a long import, VACUUM or a big ingest)
and see everything committed before they start. Inside `tx()` a thread reads through the writer instead, so it sees
its own uncommitted changes."""
import logging
import json
import sqlite3
import threading
import time
from contextlib import contextmanager

from . import config, secret_store

log = logging.getLogger(__name__)

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

# Schema changes, in two parts. LEGACY_MIGRATIONS ran before the database recorded its version: each is tried once
# more when an old database first opens, and only "this column already exists" is tolerated. Every later change is a
# numbered entry in MIGRATIONS: (version, statements), run once in a transaction and recorded as PRAGMA user_version.
# Append new ones there (never edit an applied one); a database is backed up before any of them run.
LEGACY_MIGRATIONS = [
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
    # 'text' (extracted text) or 'vision' (a unit's vision notes, embedded so image-only pages can be found)
    "ALTER TABLE chunks ADD COLUMN source TEXT NOT NULL DEFAULT 'text'",
    # vision_indexed: the document's vision notes have chunks (0 on databases from before vision chunks: backfilled)
    "ALTER TABLE documents ADD COLUMN vision_indexed INTEGER NOT NULL DEFAULT 0",
    # vision_audited: the model review has checked these notes (reset whenever the notes change)
    "ALTER TABLE units ADD COLUMN vision_audited INTEGER NOT NULL DEFAULT 0",
    # Problems found in vision notes (vision_audit.py). source: 'rule' (deterministic) | 'model' (Qwen's review);
    # kind: malformed | incomplete | misleading | failed. Dismissed flags stay so a rescan doesn't re-raise them.
    """CREATE TABLE IF NOT EXISTS vision_flags (
        id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE, kind TEXT NOT NULL, reason TEXT NOT NULL,
        source TEXT NOT NULL, created_at REAL NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0
    )""",
    "CREATE INDEX IF NOT EXISTS vision_flags_doc ON vision_flags(document_id, unit_id)",
]
LEGACY_VERSION = 1  # user_version once the legacy list has been applied

MIGRATIONS: list[tuple[int, list[str]]] = [
    # vec_version: bumped by SQLite itself whenever one of the document's chunks is added, removed or re-embedded, so the
    # in-memory search cache (search._vectors) knows when to reload it without reading any vectors
    (2, ["ALTER TABLE documents ADD COLUMN vec_version INTEGER NOT NULL DEFAULT 0",
         """CREATE TRIGGER IF NOT EXISTS chunks_vec_ins AFTER INSERT ON chunks
            BEGIN UPDATE documents SET vec_version = vec_version + 1 WHERE id = NEW.document_id; END""",
         """CREATE TRIGGER IF NOT EXISTS chunks_vec_upd AFTER UPDATE OF embedding, embed_model, document_id ON chunks
            BEGIN UPDATE documents SET vec_version = vec_version + 1 WHERE id IN (OLD.document_id, NEW.document_id); END""",
         """CREATE TRIGGER IF NOT EXISTS chunks_vec_del AFTER DELETE ON chunks
            BEGIN UPDATE documents SET vec_version = vec_version + 1 WHERE id = OLD.document_id; END"""]),
    # Job scheduling (jobs.py): priority (higher first; "Run next" raises it) and queued_at (when it last joined the
    # queue: a long vision job that yields to others goes to the back)
    (3, ["ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
         "ALTER TABLE jobs ADD COLUMN queued_at REAL",
         "UPDATE jobs SET queued_at = created_at"]),
    # The student's own notes (rich-text HTML from the notes editor). Never ingested: they may be wrong, so nothing
    # reads them into the material; Apollo only sees one when asked to check or revise it.
    # Reviews: Apollo checking ('check') or rewriting ('revise') a note or a generated notes/cheat sheet/mind map
    # artifact (target 'note' | 'artifact'), optionally only a highlighted passage (quote) of one section, run as a
    # 'review' job; result JSON holds the verdict and issues, or the proposed new HTML per section.
    # Artifact marks: the student's highlights on generated content, as character offsets into a section's text.
    # jobs.label: what an interactive job (a chat reply, a definition) is about, for the jobs list.
    (4, ["""CREATE TABLE IF NOT EXISTS user_notes (
            id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, title TEXT NOT NULL DEFAULT 'Untitled note',
            html TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL
         )""",
         """CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY, subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
            target TEXT NOT NULL, target_id INTEGER NOT NULL, section INTEGER, quote TEXT NOT NULL DEFAULT '',
            instruction TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL, status TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '', error TEXT, result TEXT, applied INTEGER NOT NULL DEFAULT 0,
            dismissed INTEGER NOT NULL DEFAULT 0, chat_id INTEGER REFERENCES chats(id) ON DELETE SET NULL,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
         )""",
         "CREATE INDEX IF NOT EXISTS reviews_target ON reviews(target, target_id)",
         """CREATE TABLE IF NOT EXISTS artifact_marks (
            id INTEGER PRIMARY KEY, artifact_id INTEGER NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
            section INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT 'yellow', created_at REAL NOT NULL
         )""",
         "ALTER TABLE jobs ADD COLUMN label TEXT"]),
    # The order the student dragged subjects (mini sidebar) and topics (right sidebar) into. NULL = not placed yet:
    # those follow the placed ones, by name.
    (5, ["ALTER TABLE subjects ADD COLUMN position INTEGER",
         "ALTER TABLE topics ADD COLUMN position INTEGER"]),
    # chats.deleted_at: soft delete (the sidebar's delete can be undone); purged a week later on start-up.
    # position: the order the student dragged to-dos, files and generated content into (NULL = not placed yet).
    (6, ["ALTER TABLE chats ADD COLUMN deleted_at REAL",
         "ALTER TABLE todos ADD COLUMN position INTEGER",
         "ALTER TABLE documents ADD COLUMN position INTEGER",
         "ALTER TABLE artifacts ADD COLUMN position INTEGER"]),
    # The knowledge cloud's stored projection (projection.py): fitted axes per scope ('all' or 'subject:N') and
    # each sampled chunk's position on them, so the cloud keeps its layout and a restart reads no vectors.
    (7, ["CREATE TABLE IF NOT EXISTS cloud_axes (scope TEXT PRIMARY KEY, model TEXT NOT NULL, n_fit INTEGER NOT NULL, "
         "mean BLOB NOT NULL, axes BLOB NOT NULL, std BLOB NOT NULL, radius REAL NOT NULL, fitted_at REAL)",
         "CREATE TABLE IF NOT EXISTS cloud_points (scope TEXT NOT NULL, chunk_id INTEGER NOT NULL, x REAL, y REAL, "
         "z REAL, PRIMARY KEY (scope, chunk_id)) WITHOUT ROWID"]),
    # Folders inside topics become rows (they were one JSON blob per subject in ui_state, rewritten on every change).
    # The blobs are converted here: folder order is kept only where the student had dragged it (`ordered`).
    (8, ["CREATE TABLE IF NOT EXISTS folders (id INTEGER PRIMARY KEY, "
         "subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE, "
         "topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER, "
         "legacy_id TEXT, created_at REAL)",
         "CREATE INDEX IF NOT EXISTS folders_topic ON folders(topic_id)",
         "ALTER TABLE documents ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL",
         "INSERT INTO folders(subject_id, topic_id, name, position, legacy_id, created_at) "
         "SELECT CAST(substr(u.key, 9) AS INTEGER), CAST(t.key AS INTEGER), json_extract(f.value, '$.name'), "
         "CASE WHEN json_extract(t.value, '$.ordered') THEN f.key END, json_extract(f.value, '$.id'), "
         "CAST(strftime('%s', 'now') AS REAL) "
         "FROM ui_state u, json_each(CASE WHEN json_valid(u.value) THEN u.value ELSE '{}' END) t, json_each(t.value, '$.folders') f "
         "WHERE u.key LIKE 'folders:%' AND json_type(t.value) = 'object' AND json_extract(f.value, '$.name') IS NOT NULL "
         "AND EXISTS (SELECT 1 FROM topics tp WHERE tp.id = CAST(t.key AS INTEGER) "
         "AND tp.subject_id = CAST(substr(u.key, 9) AS INTEGER))",
         "UPDATE documents SET folder_id = (SELECT fo.id FROM ui_state u, json_each(CASE WHEN json_valid(u.value) THEN u.value ELSE '{}' END) t, "
         "json_each(t.value, '$.files') x, folders fo "
         "WHERE u.key = 'folders:' || documents.subject_id AND json_type(t.value) = 'object' "
         "AND CAST(t.key AS INTEGER) = documents.topic_id AND x.key = CAST(documents.id AS TEXT) "
         "AND fo.legacy_id = x.value AND fo.topic_id = documents.topic_id LIMIT 1) "
         "WHERE kind = 'topic' AND topic_id IS NOT NULL",
         "DELETE FROM ui_state WHERE key LIKE 'folders:%'",
         # a file that leaves its topic (or becomes a textbook) leaves its folder
         "CREATE TRIGGER IF NOT EXISTS documents_leave_folder AFTER UPDATE OF topic_id, kind ON documents "
         "WHEN NEW.folder_id IS NOT NULL AND (NEW.topic_id IS NOT OLD.topic_id OR NEW.kind != 'topic') "
         "BEGIN UPDATE documents SET folder_id = NULL WHERE id = NEW.id; END"]),
    # Generated content and the student's notes are deleted softly (undoable), like chats; purged after a week.
    (9, ["ALTER TABLE artifacts ADD COLUMN deleted_at REAL",
         "ALTER TABLE user_notes ADD COLUMN deleted_at REAL"]),
    # deleted files wait a week in the trash (kind='trash', out of every scope) so Undo can bring them back without
    # reading them again; trash_from remembers where they were (kind, topic, folder)
    (10, ["ALTER TABLE documents ADD COLUMN deleted_at REAL",
          "ALTER TABLE documents ADD COLUMN trash_from TEXT"]),
    # three example questions Apollo wrote for the subject once it had material (questions.py; JSON list, made once)
    (11, ["ALTER TABLE subjects ADD COLUMN questions TEXT"]),
    # a Lucide icon chosen for the subject (SubjectIcon.tsx SUBJECT_ICONS), in place of the old emoji option
    (12, ["ALTER TABLE subjects ADD COLUMN icon_name TEXT"]),
]
# Rows in `jobs` that only show interactive model work in the jobs list (jobs.track); no worker runs them.
INTERACTIVE_JOBS = ("chat", "define", "quiz_review")

SCHEMA_VERSION = max([LEGACY_VERSION, *(v for v, _ in MIGRATIONS)])

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_local = threading.local()  # .reader / .reader_path: this thread's read connection; .depth: open tx() levels


class StartupError(RuntimeError):
    """The database can't be opened safely; the message is shown to the student."""


def init():
    global _conn
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.files_dir().mkdir(exist_ok=True)
    config.assets_dir().mkdir(exist_ok=True)
    _apply_pending_restore()
    fresh = not config.db_path().exists()
    _conn = sqlite3.connect(config.db_path(), check_same_thread=False, isolation_level=None)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _migrate(fresh)
    with tx() as c:
        if not fresh:  # data from before the setup steps existed: already set up
            c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES ('setup_done', 'true')")
        for k, v in config.DEFAULT_SETTINGS.items():
            v = secret_store.protect(v) if k in config.SECRET_KEYS else v
            c.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, json.dumps(v)))
        # keys saved before they were encrypted
        for k in config.SECRET_KEYS:
            r = c.execute("SELECT value FROM settings WHERE key=?", (k,)).fetchone()
            if r and (v := json.loads(r[0])) and v != secret_store.protect(v):
                c.execute("UPDATE settings SET value=? WHERE key=?", (json.dumps(secret_store.protect(v)), k))
        # Anything interrupted by a crash/quit goes back to the queue.
        # An ingest stopped mid-way resumes where it can and keeps its finished vision notes (ref_id = pipeline.KEEP_VISION).
        c.execute("UPDATE jobs SET ref_id=1 WHERE status='running' AND type='ingest' AND ref_id IS NULL")
        # Interactive work (a chat reply, a definition) died with its request: it can't be resumed.
        c.execute(f"UPDATE jobs SET status='cancelled', message='Interrupted', updated_at=? WHERE status IN ('queued','running') "
                  f"AND type IN ({','.join('?' * len(INTERACTIVE_JOBS))})", (time.time(), *INTERACTIVE_JOBS))
        c.execute("UPDATE jobs SET status='queued', updated_at=? WHERE status='running'", (time.time(),))


def _migrate(fresh: bool):
    version = _conn.execute("PRAGMA user_version").fetchone()[0]
    if version > SCHEMA_VERSION:
        raise StartupError("This data was last opened by a newer version of Apollo Study. Update the app to open it "
                           "(or restore an older backup from the backups folder).")
    if version < SCHEMA_VERSION and not fresh:
        backup("before-update")
    _conn.executescript(SCHEMA)
    if version < LEGACY_VERSION:
        for m in LEGACY_MIGRATIONS:
            try:
                _conn.execute(m)
            except sqlite3.OperationalError as e:
                if "duplicate column name" not in str(e):  # anything else is a real failure, not "already applied"
                    raise StartupError(f"Updating the database failed ({e}). Your data was backed up first.") from e
        _conn.execute(f"PRAGMA user_version = {LEGACY_VERSION}")
    for v, statements in MIGRATIONS:
        if version < v:
            try:
                with tx() as c:
                    for s in statements:
                        c.execute(s)
                    c.execute(f"PRAGMA user_version = {v}")
            except sqlite3.Error as e:
                raise StartupError(f"Updating the database to version {v} failed ({e}). Your data was backed up first.") from e


# ---------------------------------------------------------------- backups
# Whole-database copies made with SQLite's online backup API (consistent, WAL included, safe while the app runs) in
# <data>/backups. Kinds: daily (made in the background once a day), before-update (before migrations), before-restore,
# manual. The newest KEEP[kind] of each kind are kept. Restoring happens at the next start, before the database opens.

KEEP = {"daily": 3, "before-update": 2, "before-restore": 2, "manual": 5}
DAY = 24 * 3600
_backup_lock = threading.Lock()


def backup(kind: str = "manual") -> dict:
    if kind not in KEEP:
        raise ValueError(f"unknown backup kind {kind}")
    d = config.backups_dir()
    d.mkdir(parents=True, exist_ok=True)
    with _backup_lock:
        now = time.time()
        dest = d / f"study-{time.strftime('%Y%m%d-%H%M%S', time.localtime(now))}_{int(now * 1000) % 1000:03d}-{kind}.db"
        while dest.exists():  # two in the same millisecond
            dest = dest.with_name(dest.stem.replace(f"-{kind}", f"x-{kind}") + ".db")
        src = sqlite3.connect(config.db_path())  # its own connection: readers don't block the app (WAL)
        try:
            out = sqlite3.connect(dest)
            try:
                src.backup(out, pages=4096)
            finally:
                out.close()
        finally:
            src.close()
    _prune(kind)
    return _info(dest)


def _info(p) -> dict:
    parts = p.stem.split("-", 3)  # study-YYYYmmdd-HHMMSS_mmm-kind
    st = p.stat()
    return {"name": p.name, "kind": parts[3] if len(parts) == 4 else "manual", "size": st.st_size, "created_at": st.st_mtime}


def list_backups() -> list[dict]:
    d = config.backups_dir()
    if not d.exists():
        return []
    return sorted((_info(p) for p in d.glob("study-*.db") if p.is_file()), key=lambda b: (b["created_at"], b["name"]), reverse=True)


def _prune(kind: str):
    for b in [b for b in list_backups() if b["kind"] == kind][KEEP[kind]:]:
        (config.backups_dir() / b["name"]).unlink(missing_ok=True)


def backup_path(name: str):
    """A backup by file name, or None (names are checked against the folder, never joined blindly)."""
    return next((config.backups_dir() / b["name"] for b in list_backups() if b["name"] == name), None)


def delete_backup(name: str) -> bool:
    p = backup_path(name)
    if p:
        p.unlink(missing_ok=True)
    return p is not None


def _restore_marker():
    return config.DATA_DIR / "restore-pending"


def request_restore(name: str | None):
    """Restore `name` at the next start (None cancels a pending restore)."""
    if name is None:
        _restore_marker().unlink(missing_ok=True)
        return
    if backup_path(name) is None:
        raise ValueError("No such backup")
    _restore_marker().write_text(name, encoding="utf-8")


def pending_restore() -> str | None:
    m = _restore_marker()
    return m.read_text(encoding="utf-8").strip() if m.exists() else None


def _apply_pending_restore():
    """Swap in the chosen backup before the database opens; the current data is backed up first."""
    name = pending_restore()
    if not name:
        return
    _restore_marker().unlink(missing_ok=True)
    chosen = backup_path(name)
    if chosen is None:
        return
    import os
    import shutil
    # Copied beside the database first and checked, then swapped in with one rename: a copy that stops half-way (power
    # cut, full disk) or a damaged backup leaves the current data as it was.
    tmp = config.db_path().with_name(config.db_path().name + ".restoring")
    try:
        shutil.copyfile(chosen, tmp)
        check = sqlite3.connect(tmp)
        try:
            ok = check.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        finally:
            check.close()
    except (OSError, sqlite3.Error) as e:
        log.error("restore of %s skipped: %s", name, e)
        ok = False
    if not ok:
        tmp.unlink(missing_ok=True)
        log.error("backup %s is damaged or unreadable; the current data was kept", name)
        return
    if config.db_path().exists():
        backup("before-restore")
    for suffix in ("-wal", "-shm"):
        config.db_path().with_name(config.db_path().name + suffix).unlink(missing_ok=True)
    os.replace(tmp, config.db_path())


def start_backup_schedule():
    """A daily backup in the background (first one shortly after start if none was made in the last day)."""
    def loop():
        time.sleep(60)
        while True:
            try:
                last = max((b["created_at"] for b in list_backups() if b["kind"] == "daily"), default=0)
                if time.time() - last > DAY:
                    backup("daily")
            except Exception as e:  # a full disk must not take the app down; the next pass tries again
                log.error("daily backup failed: %s", e, exc_info=True)
            time.sleep(3600)
    threading.Thread(target=loop, daemon=True, name="backups").start()


@contextmanager
def tx():
    """One transaction on the writer. Nested on the same thread it joins the outer one (commits or rolls back with it)."""
    with _lock:
        if getattr(_local, "depth", 0):
            yield _conn
            return
        _conn.execute("BEGIN")
        _local.depth = getattr(_local, "depth", 0) + 1
        try:
            yield _conn
            _conn.execute("COMMIT")
        except BaseException:
            _conn.execute("ROLLBACK")
            raise
        finally:
            _local.depth -= 1


def _reader() -> sqlite3.Connection:
    path = str(config.db_path())
    c = getattr(_local, "reader", None)
    if c is None or _local.reader_path != path:
        c = sqlite3.connect(path, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA query_only = 1")
        c.execute("PRAGMA busy_timeout = 5000")
        _local.reader, _local.reader_path = c, path
    return c


def q(sql, args=()):
    if getattr(_local, "depth", 0):  # inside this thread's transaction: read its own changes
        with _lock:
            return [dict(r) for r in _conn.execute(sql, args).fetchall()]
    return [dict(r) for r in _reader().execute(sql, args).fetchall()]


def q1(sql, args=()):
    rows = q(sql, args)
    return rows[0] if rows else None


def ex(sql, args=()):
    with _lock:
        return _conn.execute(sql, args).lastrowid


def get_settings() -> dict:
    s = {r["key"]: json.loads(r["value"]) for r in q("SELECT key, value FROM settings")}
    for k in config.SECRET_KEYS:
        if k in s:
            s[k] = secret_store.unprotect(s[k])
    return s


def setting(key):
    r = q1("SELECT value FROM settings WHERE key=?", (key,))
    v = json.loads(r["value"]) if r else config.DEFAULT_SETTINGS.get(key)
    return secret_store.unprotect(v) if key in config.SECRET_KEYS else v


def put_settings(values: dict):
    with tx() as c:
        for k, v in values.items():
            if k in config.DEFAULT_SETTINGS:
                v = secret_store.protect(v) if k in config.SECRET_KEYS and isinstance(v, str) else v
                c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (k, json.dumps(v)))
