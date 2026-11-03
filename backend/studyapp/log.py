"""Logging: one rotating file, <data>/logs/backend.log (5 × 2 MB), plus stderr, which Electron shows in its console.
Modules use `logging.getLogger(__name__)`; errors the UI swallows on purpose (an offline embedding server, a figure
that can't be found) are logged here so they can still be traced. The renderer reports its own errors through
POST /client-log (logger "studyapp.ui")."""
import logging
import logging.handlers

from . import config

FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def log_path():
    return config.DATA_DIR / "logs" / "backend.log"


def setup(level=logging.INFO):
    root = logging.getLogger("studyapp")
    if root.handlers:
        return
    root.setLevel(level)
    log_path().parent.mkdir(parents=True, exist_ok=True)
    file = logging.handlers.RotatingFileHandler(log_path(), maxBytes=2 << 20, backupCount=5, encoding="utf-8")
    file.setFormatter(logging.Formatter(FORMAT))
    err = logging.StreamHandler()
    err.setFormatter(logging.Formatter(FORMAT))
    err.setLevel(logging.WARNING)
    root.addHandler(file)
    root.addHandler(err)
