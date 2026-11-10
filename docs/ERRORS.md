# Apollo Study error codes

Every error the app shows ends with a code like `APO-LLM-101`. The app says what happened in plain words; this
document gives the technical meaning, the likely causes and how to fix each one. In the app, click a code to see
its entry. Backend log lines (`<data>/logs/backend.log`) carry the same code with the full technical detail.

Generated from `backend/studyapp/errors.py` (`python -m studyapp.errors`); edit the catalogue there, not here.

## The app

### APO-APP-001 · Backend unreachable

**Shown as:** Apollo's background service isn't answering. Restart the app.

**Meaning:** The renderer's HTTP request to the local FastAPI backend failed at the network level (no response).

**HTTP status:** 503

**Likely causes:**
- the backend process exited or crashed (see <data>/logs/backend.log)
- the port is held by another program
- in development: the backend wasn't started, or `?backend=PORT` points at the wrong port

**How to fix:**
- restart the app; Electron spawns a new backend
- check backend.log for the start-up error
- in development, start the backend on the expected port

### APO-APP-002 · Request not authorised

**Shown as:** This window isn't allowed to talk to Apollo's background service. Restart the app.

**Meaning:** The backend rejected the request: the X-Apollo-Token header (or ?token= on GET) is missing or doesn't match the per-launch token.

**HTTP status:** 401

**Likely causes:**
- the backend was restarted with a new token while this window kept the old one
- in development: the page was opened without ?token= (it's in <data-dir>/backend-token)

**How to fix:**
- restart the app
- in development, open the UI with ?backend=PORT&token=TOKEN

### APO-APP-003 · Backend failed to start

**Shown as:** Apollo's background service couldn't start. Reinstall or rebuild the app; the details are in the log.

**Meaning:** The backend process exited during start-up before serving requests: a module failed to import (ImportError/ModuleNotFoundError), or another exception was raised while setting up the database, job workers or the web app. The traceback is in backend.log under this code.

**HTTP status:** 500

**Likely causes:**
- a file of the app is missing or damaged (an incomplete build, or a file removed or quarantined by antivirus)
- the packaged build was made from source that was mid-change
- a bug in start-up code

**How to fix:**
- rebuild the app (npm run dist) or reinstall it
- check that antivirus hasn't quarantined files in the app's folder
- look for APO-APP-003 in <data>/logs/backend.log and fix the import or exception it shows

### APO-APP-004 · Already running

**Shown as:** Apollo Study is already open and using this data. Use the window that's already open, or close it first.

**Meaning:** Another backend process holds the lock on this data folder (<data>/backend.lock). Two backends on one database would each run the other's background jobs and overwrite each other's work, so the second refuses to start.

**HTTP status:** 500

**Likely causes:**
- the app was started twice
- an earlier backend process is still shutting down or was left running after the window closed
- a backend started by hand is using the same --data-dir

**How to fix:**
- switch to the window that's already open
- wait a few seconds and start the app again
- end leftover 'studyapp-backend' / python processes in Task Manager
- start a hand-run backend with its own --data-dir

### APO-APP-400 · Request not accepted

**Shown as:** Apollo couldn't do that with what was given.

**Meaning:** The backend refused the request as invalid (HTTP 400). The message says which input was wrong.

**HTTP status:** 400

**Likely causes:**
- a form value outside the allowed range
- the item changed or was deleted in the meantime

**How to fix:**
- read the message, correct the input and try again
- reload the view if the item may have changed

### APO-APP-900 · Unexpected internal error

**Shown as:** Something unexpected went wrong. It's been written to the log.

**Meaning:** An exception the code doesn't handle reached the request or job boundary. The full traceback is in backend.log, tagged with this code.

**HTTP status:** 500

**Likely causes:**
- a bug
- data in a state the code didn't anticipate

**How to fix:**
- try again; if it repeats, look for APO-APP-900 in <data>/logs/backend.log and report the traceback

### APO-UI-601 · Screen failed to render

**Shown as:** This part of the screen hit a problem and was reset.

**Meaning:** A React error boundary caught an exception thrown while rendering a pane. The error and component stack were sent to the backend log (studyapp.ui).

**HTTP status:** 500

**Likely causes:**
- unexpected data shape from the backend (e.g. a malformed generated item)
- a front-end bug

**How to fix:**
- use Try again on the pane, or close and reopen the item
- if it repeats, find the stack in backend.log

## Language model

### APO-LLM-101 · Language model server unreachable

**Shown as:** Apollo can't reach its language model. Make sure the model server is running, or check its address in Settings.

**Meaning:** The TCP connection to the chat/completions server failed (connection refused, DNS failure or unreachable host).

**HTTP status:** 503

**Likely causes:**
- the model server isn't running
- the base URL in Settings has the wrong host, port or path (it must end in /v1 for OpenAI-compatible servers)
- a firewall or VPN blocks the connection

**How to fix:**
- start the model server
- Settings → Test connections, or the ? window → Set up models again
- compare the address with what the server prints on start-up

### APO-LLM-102 · Language model timed out

**Shown as:** The language model took too long to answer. Try again; if it keeps happening, the request may be too big for it.

**Meaning:** No response (or no streamed data) arrived from the language model within the client timeout.

**HTTP status:** 504

**Likely causes:**
- the server is overloaded or still loading the model
- a very large prompt (long prefill) on slow hardware
- the server hung

**How to fix:**
- wait and retry
- check the server's console for progress or errors
- restart the model server

### APO-LLM-103 · Language model key rejected

**Shown as:** The language model turned down Apollo's key. Check the key in Settings.

**Meaning:** The server answered HTTP 401 or 403 to the completions request: the Authorization bearer token is missing, wrong or revoked.

**HTTP status:** 502

**Likely causes:**
- no key entered for a server that requires one
- a typo in the key
- the OpenRouter key was deleted or ran out of credit

**How to fix:**
- re-enter the key in Settings (keys are stored DPAPI-encrypted)
- create a new key at openrouter.ai/keys

### APO-LLM-104 · Language model not found

**Shown as:** The language model Apollo asks for isn't available on the server. Pick another in Settings.

**Meaning:** The server doesn't serve the configured model id (HTTP 404/400 'model not found', or it isn't in GET /models). OpenRouter retires free models without notice.

**HTTP status:** 502

**Likely causes:**
- the model id in Settings has a typo or a different name than the server lists
- a different model is loaded in the local server
- the OpenRouter model was retired

**How to fix:**
- Settings → Test connections lists the server's models; pick one
- for OpenRouter, use Choose from list

### APO-LLM-105 · Language model rate limited

**Shown as:** The language model is busy or you've reached its limit for now. Wait a little and try again.

**Meaning:** HTTP 429 (or an upstream rate-limit error) persisted after Apollo's automatic retries, or a daily quota (e.g. OpenRouter free-models-per-day) is used up.

**HTTP status:** 429

**Likely causes:**
- too many requests to a free OpenRouter model
- the daily free allowance is spent
- other apps share the same key

**How to fix:**
- wait and retry
- lower 'Requests at once' in Settings
- use a paid model or add credit

### APO-LLM-106 · Context window exceeded

**Shown as:** That was too much text for the language model at once. Choose less material (one topic or file), or shorten the chat.

**Meaning:** The prompt plus requested output exceeds the model's context window; the server rejected it (HTTP 400 context length / too many tokens).

**HTTP status:** 400

**Likely causes:**
- the 'Context window' setting is larger than the server's real limit
- a very long chat history or attachment

**How to fix:**
- set Settings → Context window to the server's max_model_len (Test connections shows it)
- start a new chat, or use a smaller scope

### APO-LLM-107 · Invalid structured output

**Shown as:** The language model's answer couldn't be understood. Try again; a larger model is more reliable for this.

**Meaning:** chat_json could not parse or validate the model's JSON against the pydantic schema after its repair retries.

**HTTP status:** 502

**Likely causes:**
- a small model that doesn't follow JSON instructions well
- the output was cut off by max_tokens

**How to fix:**
- retry
- use a stronger model
- check backend.log for the validation error

### APO-LLM-108 · Language model server error

**Shown as:** The language model's server had a problem. Try again in a moment.

**Meaning:** The server answered HTTP 5xx (or OpenRouter reported an upstream provider error inside a 200 response).

**HTTP status:** 502

**Likely causes:**
- the server crashed or ran out of GPU memory
- the upstream provider behind OpenRouter failed

**How to fix:**
- retry
- check the model server's console
- restart the server or pick another OpenRouter model

### APO-LLM-109 · Request rejected by the language model

**Shown as:** The language model refused this request. Settings → Test connections can re-check what it supports.

**Meaning:** The server answered HTTP 4xx (other than auth/not-found/rate-limit/context) — usually a parameter its chat template doesn't accept (reasoning_effort, tools, response_format, enable_thinking).

**HTTP status:** 502

**Likely causes:**
- a server or model update changed what it accepts
- the stored server_profile is out of date

**How to fix:**
- Settings → Test connections re-probes the server and updates server_profile
- check backend.log for the server's reply

### APO-LLM-110 · Language model paused

**Shown as:** Apollo's language model is paused. Resume it from the Activity list.

**Meaning:** pause_llm is set, and this caller (chat, define) can't wait for it to be resumed (no wait hook).

**HTTP status:** 409

**Likely causes:**
- the model was paused from the Activity list to free the GPU

**How to fix:**
- Activity → Resume

## Embedding (search) model

### APO-EMB-201 · Embedding server unreachable

**Shown as:** Apollo can't reach its search (embedding) model. Make sure it's running, or check its address in Settings.

**Meaning:** The TCP connection to the /embeddings server failed (connection refused, DNS failure or unreachable host).

**HTTP status:** 503

**Likely causes:**
- the model server isn't running
- the base URL in Settings has the wrong host, port or path (it must end in /v1 for OpenAI-compatible servers)
- a firewall or VPN blocks the connection

**How to fix:**
- start the embedding server (e.g. LM Studio's local server)
- check the address in Settings

### APO-EMB-202 · Embedding model timed out

**Shown as:** The search model took too long to answer. Try again.

**Meaning:** No response from the /embeddings endpoint within the client timeout.

**HTTP status:** 504

**Likely causes:**
- the model is loading
- a large batch on CPU

**How to fix:**
- retry
- lower Settings → Embedding batch size

### APO-EMB-203 · Embedding key rejected

**Shown as:** The search model turned down Apollo's key. Check the key in Settings.

**Meaning:** HTTP 401/403 from the /embeddings endpoint.

**HTTP status:** 502

**Likely causes:**
- missing or wrong key

**How to fix:**
- re-enter the embedding key in Settings

### APO-EMB-204 · Embedding model not found

**Shown as:** The search model Apollo asks for isn't available. Check its name in Settings.

**Meaning:** The server doesn't serve the configured embedding model id.

**HTTP status:** 502

**Likely causes:**
- typo in the model id
- the model isn't loaded in LM Studio
- an OpenRouter model was retired

**How to fix:**
- load the model in the server, or correct Settings → Embedding model name
- note: changing the embedding model means files must be read again (re-ingest)

### APO-EMB-205 · Embedding rate limited

**Shown as:** The search model is busy. Apollo will need a moment; try again.

**Meaning:** HTTP 429 from the embedding endpoint after retries.

**HTTP status:** 429

**Likely causes:**
- free online embedding limits

**How to fix:**
- wait and retry

### APO-EMB-206 · Embedding server error

**Shown as:** The search model's server had a problem. Try again in a moment.

**Meaning:** HTTP 5xx or an unusable response (missing 'data' / wrong vector count) from /embeddings.

**HTTP status:** 502

**Likely causes:**
- the server crashed or ran out of memory
- an input longer than the model accepts

**How to fix:**
- retry
- check the embedding server's console
- lower the batch size

### APO-EMB-207 · Embedding model paused

**Shown as:** Apollo's search model is paused. Resume it from the Activity list.

**Meaning:** pause_embed is set; search falls back to keyword (BM25) only and new files wait before embedding.

**HTTP status:** 409

**Likely causes:**
- paused from the Activity list

**How to fix:**
- Activity → Resume

## Files

### APO-FILE-301 · File not found

**Shown as:** Apollo can't find that file any more. It may have been moved, renamed or deleted.

**Meaning:** The path doesn't exist (FileNotFoundError), or the stored copy under <data>/files is missing.

**HTTP status:** 404

**Likely causes:**
- the file was moved or deleted after it was picked
- the data folder was partly restored

**How to fix:**
- pick the file again
- Maintenance → Clean up lists missing stored files

### APO-FILE-302 · File access not granted

**Shown as:** Apollo isn't allowed to open that file. Choose it again with Add files or drag it in.

**Meaning:** grants.require refused the path: it carries no valid HMAC grant from the main process (only files picked in a dialog or dropped in are readable), or the OS denied access (PermissionError).

**HTTP status:** 403

**Likely causes:**
- the path was typed or pasted rather than picked
- the app restarted since the file was picked
- Windows permissions or another program locks the file

**How to fix:**
- pick or drop the file again
- close programs that have it open

### APO-FILE-303 · Unsupported file type

**Shown as:** Apollo can't read this kind of file. Use PDF, PowerPoint, Word, text or an image.

**Meaning:** The extension isn't in parsers.SUPPORTED.

**HTTP status:** 400

**Likely causes:**
- an .xlsx, .key, .pages, .zip or similar file

**How to fix:**
- export it to PDF first

### APO-FILE-304 · File couldn't be read

**Shown as:** Apollo couldn't open this file. It may be damaged; try saving it again as a PDF.

**Meaning:** The parser (PyMuPDF / python-pptx / python-docx / Pillow) raised while reading the file.

**HTTP status:** 400

**Likely causes:**
- a corrupt or truncated file
- an unusual format variant
- a file still being downloaded or synced

**How to fix:**
- re-save or export the file and add it again
- the parser's message is in backend.log

### APO-FILE-305 · File is password-protected

**Shown as:** This file is locked with a password. Save an unlocked copy and add that.

**Meaning:** The PDF or Office document is encrypted and can't be opened without its password.

**HTTP status:** 400

**Likely causes:**
- the file was exported with a password or DRM

**How to fix:**
- remove the password (save a copy without it)

### APO-FILE-306 · No readable text

**Shown as:** Apollo found no text in this file. If it's a scan, add it to a topic so Apollo reads its pictures.

**Meaning:** Text extraction returned nothing (image-only pages) and the file wasn't ingested, so no vision notes exist for it.

**HTTP status:** 400

**Likely causes:**
- a scanned PDF or photos of pages

**How to fix:**
- add it to a topic or the reference library with vision on (Auto or All)

### APO-FILE-307 · File too long

**Shown as:** This file is too long to use like this. Add it to a topic instead, so Apollo reads it properly.

**Meaning:** The extracted text exceeds the word limit for files read for one request (chat attachments, extra material).

**HTTP status:** 413

**Likely causes:**
- a whole textbook attached to a message

**How to fix:**
- add it to a topic or the reference library (ingested and searched)
- Settings → chat file word limit

### APO-FILE-308 · Picture not usable here

**Shown as:** Pictures can't be used as extra material yet. Add a PDF or Word file instead.

**Meaning:** Extra material for content generation is passed as text only; image files have no text layer.

**HTTP status:** 400

**Likely causes:**
- a .png/.jpg chosen as extra material

**How to fix:**
- convert it to PDF, or attach it in the chat instead

### APO-FILE-309 · Office conversion failed

**Shown as:** Apollo couldn't make an exact copy of this file to show it, so a simpler view is used.

**Meaning:** render.py couldn't export the .pptx/.docx to PDF with Microsoft Office (COM) or LibreOffice; the viewer falls back to its HTML layout.

**HTTP status:** 500

**Likely causes:**
- Office isn't installed or is busy with a dialog
- LibreOffice isn't installed

**How to fix:**
- close open Office dialogs and reopen the file
- install LibreOffice

## Making study material

### APO-GEN-401 · No material to use

**Shown as:** There's nothing for Apollo to use yet: the message says what to add or wait for.

**Meaning:** context.material_problem found no units with text or vision notes in the requested scope.

**HTTP status:** 400

**Likely causes:**
- no files in the topic
- files still being ingested
- image-only files with vision off

**How to fix:**
- add files, wait for them to finish, or run vision on them

### APO-GEN-402 · Practice exam missing

**Shown as:** Apollo needs the practice exam file to copy its layout. Choose it again.

**Meaning:** The practice_exam_path is missing, ungranted or no longer exists when the exam is generated.

**HTTP status:** 400

**Likely causes:**
- the exam file was moved after it was chosen

**How to fix:**
- pick the practice exam again and regenerate

### APO-GEN-403 · Nothing usable was made

**Shown as:** Apollo finished but nothing usable came out. Try again, perhaps with a narrower focus.

**Meaning:** The generator completed without producing items (e.g. every question was dropped as a copy of the practice exam, or the model returned empty lists).

**HTTP status:** 500

**Likely causes:**
- a model too small for the task
- a focus that matches nothing

**How to fix:**
- retry; change or remove the focus

## Saved data

### APO-DATA-501 · Database busy

**Shown as:** Apollo's data was busy for a moment. Try again.

**Meaning:** SQLite returned 'database is locked' (SQLITE_BUSY) after the busy timeout.

**HTTP status:** 503

**Likely causes:**
- a long write (backup, migration) held the writer
- another program opened study.db

**How to fix:**
- retry
- close other programs that open the data folder

### APO-DATA-502 · Disk full

**Shown as:** Your disk is full, so Apollo can't save. Free up some space and try again.

**Meaning:** A write failed with ENOSPC / SQLITE_FULL.

**HTTP status:** 507

**Likely causes:**
- the drive holding the data folder is out of space

**How to fix:**
- free space; Maintenance shows what Apollo stores
- move the data folder to another drive

### APO-DATA-503 · Database can't be opened

**Shown as:** Apollo's saved data couldn't be opened. Your data was backed up first.

**Meaning:** db.init raised StartupError: a migration failed, or the database was written by a newer version.

**HTTP status:** 500

**Likely causes:**
- an interrupted update
- opening newer data with an older app

**How to fix:**
- update the app
- restore a backup from <data>/backups

### APO-DATA-504 · Item not found

**Shown as:** That item doesn't exist any more. It may have been deleted.

**Meaning:** The requested row wasn't found (HTTP 404), or it's soft-deleted.

**HTTP status:** 404

**Likely causes:**
- deleted in another window or by a purge

**How to fix:**
- refresh the view

## Settings

### APO-SET-701 · Invalid model address

**Shown as:** That address doesn't look right. It should look like 127.0.0.1:8080.

**Meaning:** The base URL couldn't be parsed as an http(s) URL (httpx.InvalidURL / UnsupportedProtocol).

**HTTP status:** 400

**Likely causes:**
- a typo, a missing port, or a path pasted in the wrong field

**How to fix:**
- use host:port, e.g. 127.0.0.1:8080
