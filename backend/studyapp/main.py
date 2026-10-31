"""Sidecar entry point: `python -m studyapp.main --port 47615 [--data-dir DIR]`."""
import argparse
import ctypes
import os
import threading
import time

import uvicorn

from . import config, db, jobs


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
    db.init()
    jobs.start_workers()
    if args.parent_pid and os.name == "nt":
        threading.Thread(target=_watch_parent, args=(args.parent_pid,), daemon=True).start()
    from .api import app
    print(f"STUDYAPP_READY port={args.port} data={config.DATA_DIR}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
