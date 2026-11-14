"""Persistent job queue with three lanes: 'ingest' (CPU parsing + embedding, and 'embed': re-embedding stored chunks),
'vision' (vision notes, and 'audit': the model review of them) and 'generate' (content, marking, and 'review':
Apollo checking or revising notes).
Both Qwen lanes share llm's concurrency gate, so the server still sees at most `llm_concurrency` requests.
Jobs survive restarts (running -> queued on startup) and can be cancelled between steps.

Scheduling: highest priority first ("Run next" raises one), then the longest waiting (queued_at). A vision job over a
long document yields its lane after SLICE seconds when another job is waiting there, or at once when a waiting job
has a higher priority, and rejoins the back of the queue (its finished pages are kept), so a textbook can't hold up
every small upload for hours.

Pausing a model (llm.paused) holds the lanes that need it: no new job starts there, and a running one waits at its
next request to that model (llm.set_wait_hook) until it is resumed or cancelled.

Interactive model work (chat replies, definitions, quiz reviews) runs in its request, not a lane, but `track()` gives it
a row here too (db.INTERACTIVE_JOBS) so the jobs list shows everything the model is doing; cancelling one sets the
row's cancel flag, which the request checks."""
import contextlib
import logging
import threading
import time

from . import db, errors, generate, llm, pipeline, review, vision_audit

log = logging.getLogger(__name__)

_wake = threading.Event()


SLICE = 180  # seconds a yielding job runs before stepping aside for others in its lane


class Job:
    def __init__(self, row, lane):
        self.id = row["id"]
        self.document_id = row["document_id"]
        self.priority = row["priority"]
        self.types = LANES[lane]
        self.started = time.monotonic()

    def should_yield(self) -> bool:
        """Another job waits in this lane and either outranks this one, or this one has had its slice."""
        marks = ",".join("?" * len(self.types))
        top = db.q1(f"SELECT MAX(priority) p FROM jobs WHERE status='queued' AND type IN ({marks})", self.types)["p"]
        if top is None:
            return False
        return top > self.priority or time.monotonic() - self.started > SLICE

    def update(self, progress, message):
        db.ex("UPDATE jobs SET progress=?, message=?, updated_at=? WHERE id=?", (progress, message, time.time(), self.id))

    def note(self, message):
        db.ex("UPDATE jobs SET message=?, updated_at=? WHERE id=?", (message, time.time(), self.id))

    def check(self):
        row = db.q1("SELECT cancel FROM jobs WHERE id=?", (self.id,))
        if row is None or row["cancel"]:
            raise pipeline.Cancelled()


LANES = {"ingest": ("ingest", "embed"), "vision": ("vision", "audit"), "generate": ("generate", "mark", "review", "questions")}
NEEDS = {"ingest": "embed", "vision": "llm", "generate": "llm"}  # the model each lane's jobs can't start without
PAUSED_MSG = {"llm": "Paused: waiting for the language model to be resumed",
              "embed": "Paused: waiting for the embedding model to be resumed"}
RECHECK = 1  # audit job ref_id: review units that were reviewed before too


def enqueue(type_, document_id=None, ref_id=None, label=None):
    existing = db.q1("SELECT id FROM jobs WHERE type=? AND document_id IS ? AND ref_id IS ? AND status IN ('queued','running')",
                     (type_, document_id, ref_id))
    if existing:
        return existing["id"]
    now = time.time()
    jid = db.ex("INSERT INTO jobs(type, document_id, ref_id, label, status, created_at, updated_at, queued_at) VALUES (?,?,?,?,?,?,?,?)",
                (type_, document_id, ref_id, label, "queued", now, now, now))
    _wake.set()
    return jid


def prioritize(job_id) -> bool:
    """'Run next': ahead of everything waiting in its lane (and the running job there yields at its next step)."""
    row = db.q1("SELECT type, status FROM jobs WHERE id=?", (job_id,))
    if not row or row["status"] != "queued":
        return False
    types = next(t for t in LANES.values() if row["type"] in t)
    marks = ",".join("?" * len(types))
    top = db.q1(f"SELECT COALESCE(MAX(priority), 0) p FROM jobs WHERE type IN ({marks}) AND status IN ('queued','running')", types)["p"]
    db.ex("UPDATE jobs SET priority=?, updated_at=? WHERE id=?", (top + 1, time.time(), job_id))
    _wake.set()
    return True


def cancel(job_id):
    """A running job stops at its next step (its worker then marks what it was working on). A waiting one is cancelled
    here, and so is what it was for: otherwise a file would stay "queued", an exam attempt "marking", for good."""
    with db.tx() as c:
        row = c.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        c.execute("UPDATE jobs SET cancel=1 WHERE id=?", (job_id,))
        waiting = row is not None and row["status"] == "queued"
        if waiting:
            c.execute("UPDATE jobs SET status='cancelled', message='Cancelled', updated_at=? WHERE id=?", (time.time(), job_id))
    if waiting:
        _mark_owner(dict(row), "cancelled", None)


def cancel_for_document(doc_id):
    for j in db.q("SELECT id FROM jobs WHERE document_id=? AND status IN ('queued','running')", (doc_id,)):
        cancel(j["id"])


def _waiter(job):
    def wait(kind):
        before = db.q1("SELECT message FROM jobs WHERE id=?", (job.id,))
        job.note(PAUSED_MSG[kind])
        while llm.paused(kind):
            job.check()
            time.sleep(1.0)
        if before:
            job.note(before["message"])
    return wait


def _run(lane):
    """A lane's worker. Nothing may end this thread: an error outside a job (the database busy or the disk full while
    picking one or recording its result) is logged and the lane carries on, instead of stopping for good."""
    while True:
        try:
            _step(lane)
        except Exception:
            log.exception("jobs: the %s lane hit an error outside a job; continuing", lane)
            time.sleep(2.0)


def _step(lane):
    if llm.paused(NEEDS[lane]):
        time.sleep(1.0)
        return
    types = LANES[lane]
    row = db.q1(f"SELECT * FROM jobs WHERE type IN ({','.join('?' * len(types))}) AND status='queued' "
                "ORDER BY priority DESC, COALESCE(queued_at, created_at), id LIMIT 1", types)
    if row is None:
        _wake.wait(1.0)
        _wake.clear()
        return
    db.ex("UPDATE jobs SET status='running', updated_at=? WHERE id=?", (time.time(), row["id"]))
    job = Job(row, lane)
    llm.set_wait_hook(_waiter(job))
    try:
        if row["type"] == "ingest":
            if pipeline.ingest(row["document_id"], job, keep_vision=row["ref_id"] == pipeline.KEEP_VISION):
                enqueue("vision", row["document_id"])
            _ask_questions(row["document_id"])
        elif row["type"] == "vision":
            pipeline.run_vision(row["document_id"], job)
        elif row["type"] == "embed":
            pipeline.reembed(row["document_id"], job)
        elif row["type"] == "audit":
            vision_audit.review_document(row["document_id"], job, recheck=row["ref_id"] == RECHECK)
        elif row["type"] == "generate":
            generate.run_artifact(row["ref_id"], job)
        elif row["type"] == "mark":
            generate.run_marking(row["ref_id"], job)
        elif row["type"] == "review":
            review.run_review(row["ref_id"], job)
        elif row["type"] == "questions":
            from . import questions  # imports jobs
            questions.run(row["ref_id"], job)
        db.ex("UPDATE jobs SET status='done', progress=1, message='Done', updated_at=? WHERE id=?", (time.time(), row["id"]))
    except pipeline.Yield:
        db.ex("UPDATE jobs SET status='queued', priority=0, queued_at=?, updated_at=?, message='Waiting: other files go first' "
              "WHERE id=?", (time.time(), time.time(), row["id"]))
    except pipeline.Cancelled:
        db.ex("UPDATE jobs SET status='cancelled', message='Cancelled', updated_at=? WHERE id=?", (time.time(), row["id"]))
        _mark_owner(row, "cancelled", None)
    except Exception as e:
        # coded (errors.py): "plain message [APO-…]" for the student, the technical detail and traceback in the log
        err = errors.classify(e, "embed" if row["type"] in ("ingest", "embed") else "llm")
        log.exception("%s job %s (%s, ref %s) failed: %s", err.code, row["id"], row["type"], row["document_id"] or row["ref_id"],
                      err.technical or err.plain)
        db.ex("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", (str(err)[:500], time.time(), row["id"]))
        _mark_owner(row, "failed", str(err)[:500])


def _ask_questions(document_id):
    """A file finished reading: its subject's example questions, if it has none yet (questions.py)."""
    from . import questions  # imports jobs
    d = db.q1("SELECT subject_id FROM documents WHERE id=?", (document_id,))
    if d:
        try:
            questions.ensure(d["subject_id"])
        except Exception:  # never fails the ingest job
            log.exception("could not queue example questions for subject %s", d["subject_id"])


def _mark_owner(row, status, error):
    now = time.time()
    if row["type"] == "ingest":
        db.ex("UPDATE documents SET status=?, error=?, updated_at=? WHERE id=?", (status, error, now, row["document_id"]))
    elif row["type"] == "vision":  # text is already embedded, so the document stays usable
        db.ex("UPDATE documents SET status='ready', error=COALESCE(?, error), updated_at=? WHERE id=?", (error, now, row["document_id"]))
    elif row["type"] == "generate":
        db.ex("UPDATE artifacts SET status=?, error=?, updated_at=? WHERE id=?", (status, error, now, row["ref_id"]))
    elif row["type"] == "mark":
        db.ex("UPDATE attempts SET status=?, message=?, updated_at=? WHERE id=?", (status, error or status, now, row["ref_id"]))
    elif row["type"] == "review":
        db.ex("UPDATE reviews SET status=?, error=?, updated_at=? WHERE id=?", (status, error, now, row["ref_id"]))


class Tracked:
    """A jobs-list row for interactive model work (see track)."""
    def __init__(self, jid):
        self.id = jid
        self._checked = 0.0
        self._cancel = False

    def update(self, message, progress=None):
        if progress is None:
            db.ex("UPDATE jobs SET message=?, updated_at=? WHERE id=?", (message, time.time(), self.id))
        else:
            db.ex("UPDATE jobs SET message=?, progress=?, updated_at=? WHERE id=?", (message, progress, time.time(), self.id))

    def fail(self, error: str):
        db.ex("UPDATE jobs SET status='failed', error=?, message='Failed', updated_at=? WHERE id=?", (error[:500], time.time(), self.id))

    def stop(self):
        db.ex("UPDATE jobs SET status='cancelled', message='Stopped', updated_at=? WHERE id=?", (time.time(), self.id))

    def cancelled(self) -> bool:
        """Asked to stop from the jobs list (checked at most twice a second: it's called for every streamed token)."""
        if not self._cancel and time.monotonic() - self._checked > 0.5:
            self._checked = time.monotonic()
            row = db.q1("SELECT cancel FROM jobs WHERE id=?", (self.id,))
            self._cancel = row is None or bool(row["cancel"])
        return self._cancel


@contextlib.contextmanager
def track(type_: str, label: str, message: str = "Working", ref_id=None):
    """Show interactive model work (type_ in db.INTERACTIVE_JOBS) in the jobs list while the block runs: running, then
    done, failed or (when the block raised pipeline.Cancelled) cancelled."""
    now = time.time()
    jid = db.ex("INSERT INTO jobs(type, ref_id, label, status, message, created_at, updated_at, queued_at) VALUES (?,?,?,?,?,?,?,?)",
                (type_, ref_id, label[:120], "running", message, now, now, now))
    t = Tracked(jid)
    try:
        yield t
    except pipeline.Cancelled:
        db.ex("UPDATE jobs SET status='cancelled', message='Stopped', updated_at=? WHERE id=?", (time.time(), jid))
        raise
    except BaseException as e:
        # GeneratorExit: the student closed the chat stream mid-reply
        failed = not isinstance(e, GeneratorExit)
        text = str(errors.classify(e, "llm"))[:500] if failed and isinstance(e, Exception) else str(e)[:500]
        db.ex("UPDATE jobs SET status=?, error=?, message=?, updated_at=? WHERE id=?",
              ("failed" if failed else "cancelled", text if failed else None, "Failed" if failed else "Stopped",
               time.time(), jid))
        raise
    else:
        db.ex("UPDATE jobs SET status='done', progress=1, message='Done', updated_at=? WHERE id=? AND status='running'",
              (time.time(), jid))


def backfill_vision_chunks():
    """Databases from before vision notes were embedded: queue the documents whose notes have no chunks yet."""
    db.ex("UPDATE documents SET vision_indexed=1 WHERE vision_indexed=0 AND vision_done=0")
    for d in db.q("SELECT id FROM documents WHERE vision_indexed=0 AND status IN ('ready','vision')"):
        enqueue("embed", d["id"])


def set_paused(llm_paused: bool | None = None, embed_paused: bool | None = None):
    values = {k: v for k, v in (("pause_llm", llm_paused), ("pause_embed", embed_paused)) if v is not None}
    db.put_settings(values)
    return pause_state()


def pause_state() -> dict:
    out = {"llm": llm.paused("llm"), "embed": llm.paused("embed")}
    # what each pause is still waiting on: a request already sent to the model finishes first
    out["running"] = [r["type"] for r in db.q("SELECT type FROM jobs WHERE status='running'")]
    return out


def start_workers():
    backfill_vision_chunks()
    try:
        pipeline.strip_annotation_text()
    except Exception:  # tried again at the next start; the library works meanwhile (the notes are just extra text)
        log.exception("couldn't remove folded-in annotations from unit text")
    for lane in LANES:
        threading.Thread(target=_run, args=(lane,), daemon=True, name=f"jobs-{lane}").start()
