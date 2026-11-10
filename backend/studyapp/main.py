"""Sidecar entry point: `python -m studyapp.main --port 47615 [--data-dir DIR]`."""
import argparse
import ctypes
import logging
import os
import secrets
import sys
import threading
import time
import uvicorn

from . import config, db, grants, jobs, log


def _watch_parent(pid: int):
    """Exit when the Electron process that started us is gone (crash or force-kill), so no orphan stays running."""
    SYNCHRONIZE = 0x00100000
    handle = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
    if not handle:
        return
    ctypes.windll.kernel32.WaitForSingleObject(handle, 0xFFFFFFFF)
    time.sleep(0.5)
    os._exit(0)


_data_lock = None  # the open lock file: held for the life of the process


def _lock_data_dir(wait: float = 6.0) -> bool:
    """One backend per data folder: a second one would requeue the first one's running jobs and write to the same
    database. Holds an exclusive lock on <data>/backend.lock until the process ends (the system releases it even after
    a crash). Waits a few seconds first, for a previous backend that is still shutting down."""
    global _data_lock
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    f = open(config.DATA_DIR / "backend.lock", "a+b")
    end = time.monotonic() + wait
    while True:
        try:
            f.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            _data_lock = f
            return True
        except OSError:
            if time.monotonic() >= end:
                f.close()
                return False
            time.sleep(0.3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=47615)
    ap.add_argument("--data-dir")
    ap.add_argument("--parent-pid", type=int)
    args = ap.parse_args()
    config.set_data_dir(args.data_dir)
    log.setup()
    # Electron passes the token in the environment (not the command line, which other programs can read). Started by
    # hand, the backend makes its own: open the UI with ?backend=PORT&token=<the backend-token file's contents>.
    config.API_TOKEN = os.environ.pop("APOLLO_TOKEN", None) or secrets.token_urlsafe(32)
    grants.KEY = os.environ.pop("APOLLO_GRANT_KEY", None)  # set by Electron; without it file paths aren't checked
    if not _lock_data_dir():
        logging.getLogger("studyapp.main").error("APO-APP-004 another backend is using %s", config.DATA_DIR)
        print("STUDYAPP_ERROR Apollo Study is already open and using this data. Use the window that's already open, or "
              "close it first. [APO-APP-004]", file=sys.stderr, flush=True)
        sys.exit(5)
    try:
        db.init()
    except db.StartupError as e:
        logging.getLogger("studyapp.main").error("APO-DATA-503 database start-up failed: %s", e)
        print(f"STUDYAPP_ERROR {e} [APO-DATA-503]", file=sys.stderr, flush=True)
        sys.exit(3)
    config.token_file().write_text(config.API_TOKEN, encoding="utf-8")
    db.start_backup_schedule()
    jobs.start_workers()
    try:
        from .chat_api import purge_deleted_chats
        from .study_api import purge_deleted
        purge_deleted_chats()
        purge_deleted()
    except Exception:
        logging.getLogger("studyapp.main").warning("couldn't purge deleted chats, content or notes", exc_info=True)
    if args.parent_pid and os.name == "nt":
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()
    try:
        from .api import app
    except Exception as e:  # a missing or broken module: say so plainly (Electron shows this line) and log the traceback
        logging.getLogger("studyapp.main").exception("APO-APP-003 backend start-up failed: %s: %s", type(e).__name__, e)
        print(f"STUDYAPP_ERROR Apollo's background service couldn't start ({type(e).__name__}: {e}). "
              f"Details are in {config.DATA_DIR / 'logs' / 'backend.log'}. [APO-APP-003]", file=sys.stderr, flush=True)
        sys.exit(4)
    try:
        from .api import purge_trash
        purge_trash()
    except Exception:
        logging.getLogger("studyapp.main").warning("couldn't empty the file trash", exc_info=True)
    try:  # subjects with material but no example questions yet (made once each; questions.py)
        from .questions import ensure_all
        ensure_all()
    except Exception:
        logging.getLogger("studyapp.main").warning("couldn't queue example questions", exc_info=True)
    # files read while the embedding model was off (the example subject) get their vectors once it answers
    threading.Thread(target=_embed_waiting, daemon=True).start()
    print(f"STUDYAPP_READY port={args.port} data={config.DATA_DIR}", flush=True)
    # Headers up to 1 MB: the grants for the files of one request travel in a header (grants.py), and the default
    # 16 KB refused an upload of more than about 70 files at once.
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning", h11_max_incomplete_event_size=1 << 20)


def _embed_waiting():
    try:
        from .examples import embed_waiting
        embed_waiting()
    except Exception:
        logging.getLogger("studyapp.main").warning("couldn't queue waiting embeddings", exc_info=True)


if __name__ == "__main__":
    main()
