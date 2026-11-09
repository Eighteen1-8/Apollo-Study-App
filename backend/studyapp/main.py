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
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


def _embed_waiting():
    try:
        from .examples import embed_waiting
        embed_waiting()
    except Exception:
        logging.getLogger("studyapp.main").warning("couldn't queue waiting embeddings", exc_info=True)


if __name__ == "__main__":
    main()
