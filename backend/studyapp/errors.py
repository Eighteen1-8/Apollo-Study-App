"""Error codes: every failure the student can see has a code (APO-<AREA>-<NNN>), a plain message for the app and a
technical entry (what it means, likely causes, how to fix it) for docs/ERRORS.md and the app's error reference.

- `AppError(code, technical, plain=None)` is raised where the cause is known. str(err) is "plain message [CODE]", so
  stored errors (jobs, artifacts, documents) and chat error events carry the code; the UI turns it into a link.
- `classify(exc, kind)` turns anything else (httpx, sqlite, OS errors, …) into an AppError, so nothing reaches the
  student as a bare Python exception. `kind` ("llm" | "embed") says which model a network error came from.
- The API answers every error as {"detail": plain, "code": CODE, "technical": short} (api.py's handlers).
- `python -m studyapp.errors > ../docs/ERRORS.md` writes the error document; a test checks it's up to date.
"""
import errno
import re
import sqlite3
from dataclasses import dataclass

import httpx


@dataclass(frozen=True)
class Info:
    title: str     # the technical name of the failure
    plain: str     # what the app tells the student (no jargon)
    meaning: str   # accurate technical description
    causes: tuple  # likely causes, technical
    fixes: tuple   # what to do, technical
    status: int = 500  # HTTP status when it ends a request


def _i(title, plain, meaning, causes, fixes, status=500):
    return Info(title, plain, meaning, tuple(causes), tuple(fixes), status)


_SERVER = ("the model server isn't running", "the base URL in Settings has the wrong host, port or path (it must end in /v1 for "
           "OpenAI-compatible servers)", "a firewall or VPN blocks the connection")

CATALOGUE: dict[str, Info] = {
    # ---------------------------------------------------------------- the app itself
    "APO-APP-001": _i("Backend unreachable", "Apollo's background service isn't answering. Restart the app.",
                      "The renderer's HTTP request to the local FastAPI backend failed at the network level (no response).",
                      ["the backend process exited or crashed (see <data>/logs/backend.log)", "the port is held by another program",
                       "in development: the backend wasn't started, or `?backend=PORT` points at the wrong port"],
                      ["restart the app; Electron spawns a new backend", "check backend.log for the start-up error",
                       "in development, start the backend on the expected port"], 503),
    "APO-APP-002": _i("Request not authorised", "This window isn't allowed to talk to Apollo's background service. Restart the app.",
                      "The backend rejected the request: the X-Apollo-Token header (or ?token= on GET) is missing or doesn't match the per-launch token.",
                      ["the backend was restarted with a new token while this window kept the old one",
                       "in development: the page was opened without ?token= (it's in <data-dir>/backend-token)"],
                      ["restart the app", "in development, open the UI with ?backend=PORT&token=TOKEN"], 401),
    "APO-APP-003": _i("Backend failed to start", "Apollo's background service couldn't start. Reinstall or rebuild the app; "
                      "the details are in the log.",
                      "The backend process exited during start-up before serving requests: a module failed to import "
                      "(ImportError/ModuleNotFoundError), or another exception was raised while setting up the database, job "
                      "workers or the web app. The traceback is in backend.log under this code.",
                      ["a file of the app is missing or damaged (an incomplete build, or a file removed or quarantined by "
                       "antivirus)", "the packaged build was made from source that was mid-change", "a bug in start-up code"],
                      ["rebuild the app (npm run dist) or reinstall it", "check that antivirus hasn't quarantined files in the "
                       "app's folder", "look for APO-APP-003 in <data>/logs/backend.log and fix the import or exception it shows"]),
    "APO-APP-004": _i("Already running", "Apollo Study is already open and using this data. Use the window that's already "
                      "open, or close it first.",
                      "Another backend process holds the lock on this data folder (<data>/backend.lock). Two backends on one "
                      "database would each run the other's background jobs and overwrite each other's work, so the second "
                      "refuses to start.",
                      ["the app was started twice", "an earlier backend process is still shutting down or was left running "
                       "after the window closed", "a backend started by hand is using the same --data-dir"],
                      ["switch to the window that's already open", "wait a few seconds and start the app again", "end leftover "
                       "'studyapp-backend' / python processes in Task Manager", "start a hand-run backend with its own --data-dir"]),
    "APO-APP-400": _i("Request not accepted", "Apollo couldn't do that with what was given.",
                      "The backend refused the request as invalid (HTTP 400). The message says which input was wrong.",
                      ["a form value outside the allowed range", "the item changed or was deleted in the meantime"],
                      ["read the message, correct the input and try again", "reload the view if the item may have changed"], 400),
    "APO-APP-900": _i("Unexpected internal error", "Something unexpected went wrong. It's been written to the log.",
                      "An exception the code doesn't handle reached the request or job boundary. The full traceback is in backend.log, "
                      "tagged with this code.",
                      ["a bug", "data in a state the code didn't anticipate"],
                      ["try again; if it repeats, look for APO-APP-900 in <data>/logs/backend.log and report the traceback"]),
    "APO-UI-601": _i("Screen failed to render", "This part of the screen hit a problem and was reset.",
                     "A React error boundary caught an exception thrown while rendering a pane. The error and component stack were sent "
                     "to the backend log (studyapp.ui).",
                     ["unexpected data shape from the backend (e.g. a malformed generated item)", "a front-end bug"],
                     ["use Try again on the pane, or close and reopen the item", "if it repeats, find the stack in backend.log"]),
    # ---------------------------------------------------------------- the language model
    "APO-LLM-101": _i("Language model server unreachable", "Apollo can't reach its language model. Make sure the model server is "
                      "running, or check its address in Settings.",
                      "The TCP connection to the chat/completions server failed (connection refused, DNS failure or unreachable host).",
                      _SERVER, ["start the model server", "Settings → Test connections, or the ? window → Set up models again",
                                "compare the address with what the server prints on start-up"], 503),
    "APO-LLM-102": _i("Language model timed out", "The language model took too long to answer. Try again; if it keeps happening, "
                      "the request may be too big for it.",
                      "No response (or no streamed data) arrived from the language model within the client timeout.",
                      ["the server is overloaded or still loading the model", "a very large prompt (long prefill) on slow hardware",
                       "the server hung"],
                      ["wait and retry", "check the server's console for progress or errors", "restart the model server"], 504),
    "APO-LLM-103": _i("Language model key rejected", "The language model turned down Apollo's key. Check the key in Settings.",
                      "The server answered HTTP 401 or 403 to the completions request: the Authorization bearer token is missing, wrong or revoked.",
                      ["no key entered for a server that requires one", "a typo in the key", "the OpenRouter key was deleted or ran out of credit"],
                      ["re-enter the key in Settings (keys are stored DPAPI-encrypted)", "create a new key at openrouter.ai/keys"], 502),
    "APO-LLM-104": _i("Language model not found", "The language model Apollo asks for isn't available on the server. Pick another "
                      "in Settings.",
                      "The server doesn't serve the configured model id (HTTP 404/400 'model not found', or it isn't in GET /models). "
                      "OpenRouter retires free models without notice.",
                      ["the model id in Settings has a typo or a different name than the server lists",
                       "a different model is loaded in the local server", "the OpenRouter model was retired"],
                      ["Settings → Test connections lists the server's models; pick one", "for OpenRouter, use Choose from list"], 502),
    "APO-LLM-105": _i("Language model rate limited", "The language model is busy or you've reached its limit for now. Wait a little "
                      "and try again.",
                      "HTTP 429 (or an upstream rate-limit error) persisted after Apollo's automatic retries, or a daily quota "
                      "(e.g. OpenRouter free-models-per-day) is used up.",
                      ["too many requests to a free OpenRouter model", "the daily free allowance is spent", "other apps share the same key"],
                      ["wait and retry", "lower 'Requests at once' in Settings", "use a paid model or add credit"], 429),
    "APO-LLM-106": _i("Context window exceeded", "That was too much text for the language model at once. Choose less material "
                      "(one topic or file), or shorten the chat.",
                      "The prompt plus requested output exceeds the model's context window; the server rejected it (HTTP 400 "
                      "context length / too many tokens).",
                      ["the 'Context window' setting is larger than the server's real limit", "a very long chat history or attachment"],
                      ["set Settings → Context window to the server's max_model_len (Test connections shows it)",
                       "start a new chat, or use a smaller scope"], 400),
    "APO-LLM-107": _i("Invalid structured output", "The language model's answer couldn't be understood. Try again; a larger model "
                      "is more reliable for this.",
                      "chat_json could not parse or validate the model's JSON against the pydantic schema after its repair retries.",
                      ["a small model that doesn't follow JSON instructions well", "the output was cut off by max_tokens"],
                      ["retry", "use a stronger model", "check backend.log for the validation error"], 502),
    "APO-LLM-108": _i("Language model server error", "The language model's server had a problem. Try again in a moment.",
                      "The server answered HTTP 5xx (or OpenRouter reported an upstream provider error inside a 200 response).",
                      ["the server crashed or ran out of GPU memory", "the upstream provider behind OpenRouter failed"],
                      ["retry", "check the model server's console", "restart the server or pick another OpenRouter model"], 502),
    "APO-LLM-109": _i("Request rejected by the language model", "The language model refused this request. Settings → Test connections "
                      "can re-check what it supports.",
                      "The server answered HTTP 4xx (other than auth/not-found/rate-limit/context) — usually a parameter its chat "
                      "template doesn't accept (reasoning_effort, tools, response_format, enable_thinking).",
                      ["a server or model update changed what it accepts", "the stored server_profile is out of date"],
                      ["Settings → Test connections re-probes the server and updates server_profile", "check backend.log for the server's reply"], 502),
    "APO-LLM-110": _i("Language model paused", "Apollo's language model is paused. Resume it from the Activity list.",
                      "pause_llm is set, and this caller (chat, define) can't wait for it to be resumed (no wait hook).",
                      ["the model was paused from the Activity list to free the GPU"], ["Activity → Resume"], 409),
    # ---------------------------------------------------------------- the embedding model
    "APO-EMB-201": _i("Embedding server unreachable", "Apollo can't reach its search (embedding) model. Make sure it's running, or "
                      "check its address in Settings.",
                      "The TCP connection to the /embeddings server failed (connection refused, DNS failure or unreachable host).",
                      _SERVER, ["start the embedding server (e.g. LM Studio's local server)", "check the address in Settings"], 503),
    "APO-EMB-202": _i("Embedding model timed out", "The search model took too long to answer. Try again.",
                      "No response from the /embeddings endpoint within the client timeout.",
                      ["the model is loading", "a large batch on CPU"], ["retry", "lower Settings → Embedding batch size"], 504),
    "APO-EMB-203": _i("Embedding key rejected", "The search model turned down Apollo's key. Check the key in Settings.",
                      "HTTP 401/403 from the /embeddings endpoint.", ["missing or wrong key"], ["re-enter the embedding key in Settings"], 502),
    "APO-EMB-204": _i("Embedding model not found", "The search model Apollo asks for isn't available. Check its name in Settings.",
                      "The server doesn't serve the configured embedding model id.",
                      ["typo in the model id", "the model isn't loaded in LM Studio", "an OpenRouter model was retired"],
                      ["load the model in the server, or correct Settings → Embedding model name",
                       "note: changing the embedding model means files must be read again (re-ingest)"], 502),
    "APO-EMB-205": _i("Embedding rate limited", "The search model is busy. Apollo will need a moment; try again.",
                      "HTTP 429 from the embedding endpoint after retries.", ["free online embedding limits"], ["wait and retry"], 429),
    "APO-EMB-206": _i("Embedding server error", "The search model's server had a problem. Try again in a moment.",
                      "HTTP 5xx or an unusable response (missing 'data' / wrong vector count) from /embeddings.",
                      ["the server crashed or ran out of memory", "an input longer than the model accepts"],
                      ["retry", "check the embedding server's console", "lower the batch size"], 502),
    "APO-EMB-207": _i("Embedding model paused", "Apollo's search model is paused. Resume it from the Activity list.",
                      "pause_embed is set; search falls back to keyword (BM25) only and new files wait before embedding.",
                      ["paused from the Activity list"], ["Activity → Resume"], 409),
    # ---------------------------------------------------------------- files
    "APO-FILE-301": _i("File not found", "Apollo can't find that file any more. It may have been moved, renamed or deleted.",
                       "The path doesn't exist (FileNotFoundError), or the stored copy under <data>/files is missing.",
                       ["the file was moved or deleted after it was picked", "the data folder was partly restored"],
                       ["pick the file again", "Maintenance → Clean up lists missing stored files"], 404),
    "APO-FILE-302": _i("File access not granted", "Apollo isn't allowed to open that file. Choose it again with Add files or drag it in.",
                       "grants.require refused the path: it carries no valid HMAC grant from the main process (only files picked "
                       "in a dialog or dropped in are readable), or the OS denied access (PermissionError).",
                       ["the path was typed or pasted rather than picked", "the app restarted since the file was picked",
                        "Windows permissions or another program locks the file"],
                       ["pick or drop the file again", "close programs that have it open"], 403),
    "APO-FILE-303": _i("Unsupported file type", "Apollo can't read this kind of file. Use PDF, PowerPoint, Word, text or an image.",
                       "The extension isn't in parsers.SUPPORTED.", ["an .xlsx, .key, .pages, .zip or similar file"],
                       ["export it to PDF first"], 400),
    "APO-FILE-304": _i("File couldn't be read", "Apollo couldn't open this file. It may be damaged; try saving it again as a PDF.",
                       "The parser (PyMuPDF / python-pptx / python-docx / Pillow) raised while reading the file.",
                       ["a corrupt or truncated file", "an unusual format variant", "a file still being downloaded or synced"],
                       ["re-save or export the file and add it again", "the parser's message is in backend.log"], 400),
    "APO-FILE-305": _i("File is password-protected", "This file is locked with a password. Save an unlocked copy and add that.",
                       "The PDF or Office document is encrypted and can't be opened without its password.",
                       ["the file was exported with a password or DRM"], ["remove the password (save a copy without it)"], 400),
    "APO-FILE-306": _i("No readable text", "Apollo found no text in this file. If it's a scan, add it to a topic so Apollo reads its "
                       "pictures.", "Text extraction returned nothing (image-only pages) and the file wasn't ingested, so no vision "
                       "notes exist for it.", ["a scanned PDF or photos of pages"],
                       ["add it to a topic or the reference library with vision on (Auto or All)"], 400),
    "APO-FILE-307": _i("File too long", "This file is too long to use like this. Add it to a topic instead, so Apollo reads it properly.",
                       "The extracted text exceeds the word limit for files read for one request (chat attachments, extra material).",
                       ["a whole textbook attached to a message"], ["add it to a topic or the reference library (ingested and searched)",
                                                                     "Settings → chat file word limit"], 413),
    "APO-FILE-308": _i("Picture not usable here", "Pictures can't be used as extra material yet. Add a PDF or Word file instead.",
                       "Extra material for content generation is passed as text only; image files have no text layer.",
                       ["a .png/.jpg chosen as extra material"], ["convert it to PDF, or attach it in the chat instead"], 400),
    "APO-FILE-309": _i("Office conversion failed", "Apollo couldn't make an exact copy of this file to show it, so a simpler view is used.",
                       "render.py couldn't export the .pptx/.docx to PDF with Microsoft Office (COM) or LibreOffice; the viewer falls "
                       "back to its HTML layout.", ["Office isn't installed or is busy with a dialog", "LibreOffice isn't installed"],
                       ["close open Office dialogs and reopen the file", "install LibreOffice"], 500),
    # ---------------------------------------------------------------- making content
    "APO-GEN-401": _i("No material to use", "There's nothing for Apollo to use yet: the message says what to add or wait for.",
                      "context.material_problem found no units with text or vision notes in the requested scope.",
                      ["no files in the topic", "files still being ingested", "image-only files with vision off"],
                      ["add files, wait for them to finish, or run vision on them"], 400),
    "APO-GEN-402": _i("Practice exam missing", "Apollo needs the practice exam file to copy its layout. Choose it again.",
                      "The practice_exam_path is missing, ungranted or no longer exists when the exam is generated.",
                      ["the exam file was moved after it was chosen"], ["pick the practice exam again and regenerate"], 400),
    "APO-GEN-403": _i("Nothing usable was made", "Apollo finished but nothing usable came out. Try again, perhaps with a narrower focus.",
                      "The generator completed without producing items (e.g. every question was dropped as a copy of the practice "
                      "exam, or the model returned empty lists).", ["a model too small for the task", "a focus that matches nothing"],
                      ["retry; change or remove the focus"], 500),
    # ---------------------------------------------------------------- data
    "APO-DATA-501": _i("Database busy", "Apollo's data was busy for a moment. Try again.",
                       "SQLite returned 'database is locked' (SQLITE_BUSY) after the busy timeout.",
                       ["a long write (backup, migration) held the writer", "another program opened study.db"],
                       ["retry", "close other programs that open the data folder"], 503),
    "APO-DATA-502": _i("Disk full", "Your disk is full, so Apollo can't save. Free up some space and try again.",
                       "A write failed with ENOSPC / SQLITE_FULL.", ["the drive holding the data folder is out of space"],
                       ["free space; Maintenance shows what Apollo stores", "move the data folder to another drive"], 507),
    "APO-DATA-503": _i("Database can't be opened", "Apollo's saved data couldn't be opened. Your data was backed up first.",
                       "db.init raised StartupError: a migration failed, or the database was written by a newer version.",
                       ["an interrupted update", "opening newer data with an older app"],
                       ["update the app", "restore a backup from <data>/backups"], 500),
    "APO-DATA-504": _i("Item not found", "That item doesn't exist any more. It may have been deleted.",
                       "The requested row wasn't found (HTTP 404), or it's soft-deleted.", ["deleted in another window or by a purge"],
                       ["refresh the view"], 404),
    # ---------------------------------------------------------------- settings
    "APO-SET-701": _i("Invalid model address", "That address doesn't look right. It should look like 127.0.0.1:8080.",
                      "The base URL couldn't be parsed as an http(s) URL (httpx.InvalidURL / UnsupportedProtocol).",
                      ["a typo, a missing port, or a path pasted in the wrong field"], ["use host:port, e.g. 127.0.0.1:8080"], 400),
}

CODE_RE = re.compile(r"\[(APO-[A-Z]+-\d{3})\]")
# HTTP status → code, for HTTPExceptions raised without one (their detail is already a plain message)
STATUS_CODES = {400: "APO-APP-400", 401: "APO-APP-002", 403: "APO-FILE-302", 404: "APO-DATA-504", 413: "APO-FILE-307",
                422: "APO-APP-400", 409: "APO-APP-400"}


class AppError(RuntimeError):
    """A failure with a code. `plain` overrides the catalogue's message when the code has more specific words."""

    def __init__(self, code: str, technical: str = "", plain: str | None = None):
        info = CATALOGUE[code]
        self.code, self.info = code, info
        self.plain = plain or info.plain
        self.technical = technical
        super().__init__(f"{self.plain} [{code}]")

    @property
    def status(self) -> int:
        return self.info.status


def coded(text: str) -> str | None:
    """The code inside a stored error string, if any."""
    m = CODE_RE.search(text or "")
    return m.group(1) if m else None


def _http_code(status: int, body: str, kind: str) -> str:
    b = body.lower()
    pre = "APO-EMB-2" if kind == "embed" else "APO-LLM-1"
    if status in (401, 403):
        return pre + "03"
    if status == 429 or "rate limit" in b or "per-day" in b:
        return pre + "05"
    if status == 404 or re.search(r"model .{0,80}(not found|does not exist|not available)|no endpoints found|not a valid model", b):
        return pre + "04"
    if kind != "embed" and re.search(r"context|too many tokens|maximum.{0,30}length|prompt is too long", b):
        return "APO-LLM-106"
    if status >= 500:
        return pre + ("08" if kind != "embed" else "06")
    return "APO-LLM-109" if kind != "embed" else "APO-EMB-206"


def http_error(status: int, body: str, kind: str, where: str) -> AppError:
    """A model server's non-200 answer, with the code for what went wrong."""
    return AppError(_http_code(status, body, kind), f"{where} HTTP {status}: {body[:400]}")


def classify(exc: BaseException, kind: str | None = None) -> AppError:
    """Any exception as an AppError (an AppError is returned as it is)."""
    if isinstance(exc, AppError):
        return exc
    name = f"{type(exc).__name__}: {exc}"
    msg = str(exc)
    low = msg.lower()
    from .llm import Paused  # late: llm imports this module
    if isinstance(exc, Paused):
        return AppError("APO-EMB-207" if "embedding" in low else "APO-LLM-110", name)
    pre = "APO-EMB-2" if kind == "embed" else "APO-LLM-1"
    if isinstance(exc, (httpx.InvalidURL, httpx.UnsupportedProtocol)):
        return AppError("APO-SET-701", name)
    if isinstance(exc, httpx.TimeoutException):
        return AppError(pre + "02", name)
    if isinstance(exc, (httpx.ConnectError, httpx.RemoteProtocolError, httpx.NetworkError)):
        return AppError(pre + "01", name)
    if isinstance(exc, sqlite3.OperationalError):
        if "locked" in low or "busy" in low:
            return AppError("APO-DATA-501", name)
        if "full" in low:
            return AppError("APO-DATA-502", name)
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == errno.ENOSPC:
        return AppError("APO-DATA-502", name)
    if isinstance(exc, FileNotFoundError):
        return AppError("APO-FILE-301", name)
    if isinstance(exc, PermissionError):
        return AppError("APO-FILE-302", name)
    if "password" in low or "encrypted" in low:
        return AppError("APO-FILE-305", name)
    if "did not return valid json" in low:
        return AppError("APO-LLM-107", name)
    if "practice exam file not found" in low:
        return AppError("APO-GEN-402", name)
    if re.search(r"no files yet|still being processed|no readable (text|material)|failed to ingest|run vision on", low):
        return AppError("APO-GEN-401", name, plain=msg)  # context.material_problem: already plain and specific
    return AppError("APO-APP-900", name)


def markdown() -> str:
    """docs/ERRORS.md: every code with its technical meaning, causes and fixes."""
    areas = {"APP": "The app", "UI": "The app", "LLM": "Language model", "EMB": "Embedding (search) model", "FILE": "Files",
             "GEN": "Making study material", "DATA": "Saved data", "SET": "Settings"}
    out = ["# Apollo Study error codes", "",
           "Every error the app shows ends with a code like `APO-LLM-101`. The app says what happened in plain words; this",
           "document gives the technical meaning, the likely causes and how to fix each one. In the app, click a code to see",
           "its entry. Backend log lines (`<data>/logs/backend.log`) carry the same code with the full technical detail.", "",
           "Generated from `backend/studyapp/errors.py` (`python -m studyapp.errors`); edit the catalogue there, not here.", ""]
    last = None
    for code, i in CATALOGUE.items():
        area = areas[code.split("-")[1]]
        if area != last:
            out += [f"## {area}", ""]
            last = area
        out += [f"### {code} · {i.title}", "", f"**Shown as:** {i.plain}", "", f"**Meaning:** {i.meaning}", "", f"**HTTP status:** {i.status}", "",
                "**Likely causes:**", *[f"- {c}" for c in i.causes], "", "**How to fix:**", *[f"- {f}" for f in i.fixes], ""]
    return "\n".join(out)


def catalogue_json() -> list[dict]:
    return [{"code": c, "title": i.title, "plain": i.plain, "meaning": i.meaning, "causes": list(i.causes), "fixes": list(i.fixes),
             "status": i.status} for c, i in CATALOGUE.items()]


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    print(markdown(), end="")
