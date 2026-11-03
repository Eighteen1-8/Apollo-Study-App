"""Persistent job queue with three lanes: 'ingest' (CPU parsing + embedding, and 'embed': re-embedding stored chunks),
'vision' (vision notes, and 'audit': the model review of them) and 'generate' (content + marking).
Both Qwen lanes share llm's concurrency gate, so the server still sees at most `llm_concurrency` requests.
Jobs survive restarts (running -> queued on startup) and can be cancelled between steps.

Scheduling: highest priority first ("Run next" raises one), then the longest waiting (queued_at). A vision job over a
long document yields its lane after SLICE seconds when another job is waiting there, or at once when a waiting job
has a higher priority, and rejoins the back of the queue (its finished pages are kept), so a textbook can't hold up
every small upload for hours.

Pausing a model (llm.paused) holds the lanes that need it: no new job starts there, and a running one waits at its
next request to that model (llm.set_wait_hook) until it is resumed or cancelled."""
import logging
import threading
import time

from . import db, generate, llm, pipeline, vision_audit

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


LANES = {"ingest": ("ingest", "embed"), "vision": ("vision", "audit"), "generate": ("generate", "mark")}
NEEDS = {"ingest": "embed", "vision": "llm", "generate": "llm"}  # the model each lane's jobs can't start without
PAUSED_MSG = {"llm": "Paused: waiting for the language model to be resumed",
              "embed": "Paused: waiting for the embedding model to be resumed"}
RECHECK = 1  # audit job ref_id: review units that were reviewed before too


def enqueue(type_, document_id=None, ref_id=None):
    existing = db.q1("SELECT id FROM jobs WHERE type=? AND document_id IS ? AND ref_id IS ? AND status IN ('queued','running')",
                     (type_, document_id, ref_id))
    if existing:
        return existing["id"]
    now = time.time()
    jid = db.ex("INSERT INTO jobs(type, document_id, ref_id, status, created_at, updated_at, queued_at) VALUES (?,?,?,?,?,?,?)",
                (type_, document_id, ref_id, "queued", now, now, now))
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
    db.ex("UPDATE jobs SET cancel=1 WHERE id=?", (job_id,))
    db.ex("UPDATE jobs SET status='cancelled', updated_at=? WHERE id=? AND status='queued'", (time.time(), job_id))


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
    while True:
        if llm.paused(NEEDS[lane]):
            time.sleep(1.0)
            continue
        types = LANES[lane]
        row = db.q1(f"SELECT * FROM jobs WHERE type IN ({','.join('?' * len(types))}) AND status='queued' "
                    "ORDER BY priority DESC, COALESCE(queued_at, created_at), id LIMIT 1", types)
        if row is None:
            _wake.wait(1.0)
            _wake.clear()
            continue
        db.ex("UPDATE jobs SET status='running', updated_at=? WHERE id=?", (time.time(), row["id"]))
        job = Job(row, lane)
        llm.set_wait_hook(_waiter(job))
        try:
            if row["type"] == "ingest":
                if pipeline.ingest(row["document_id"], job, keep_vision=row["ref_id"] == pipeline.KEEP_VISION):
                    enqueue("vision", row["document_id"])
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
            db.ex("UPDATE jobs SET status='done', progress=1, message='Done', updated_at=? WHERE id=?", (time.time(), row["id"]))
        except pipeline.Yield:
            db.ex("UPDATE jobs SET status='queued', priority=0, queued_at=?, updated_at=?, message='Waiting: other files go first' "
                  "WHERE id=?", (time.time(), time.time(), row["id"]))
        except pipeline.Cancelled:
            db.ex("UPDATE jobs SET status='cancelled', message='Cancelled', updated_at=? WHERE id=?", (time.time(), row["id"]))
            _mark_owner(row, "cancelled", None)
        except Exception as e:
            log.exception("job %s (%s) failed", row["id"], row["type"])
            db.ex("UPDATE jobs SET status='failed', error=?, updated_at=? WHERE id=?", (str(e), time.time(), row["id"]))
            _mark_owner(row, "failed", str(e)[:500])


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
    for lane in LANES:
        threading.Thread(target=_run, args=(lane,), daemon=True, name=f"jobs-{lane}").start()
