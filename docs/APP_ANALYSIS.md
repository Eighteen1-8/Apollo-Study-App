# Apollo Study: code health analysis

Written 2026-11-03 against the working tree (Electron 33 / React 18 / Vite 5 front end, FastAPI + SQLite sidecar).
These are notes only: nothing listed here has been changed. Each item says where it lives, why it matters, and a
suggested direction. Severity: **High** (data loss, security, or likely breakage soon), **Medium** (real cost or
fragility), **Low** (tidiness, polish).

---

## 1. Security and privacy

| # | Severity | Finding |
|---|---|---|
| 1.1 | ~~High~~ **Fixed 2026-11-03** | **The backend had no authentication, and its CORS allows `Origin: null`.** *Fixed:* every request now needs a per-launch token (`api.require_token`). Electron generates it, passes it to the sidecar by environment variable and to the renderer through the preload. Media URLs carry it as `?token=`. `file://` was dropped from CORS; `null` stays because the packaged app's page sends it, and the token is what keeps other pages out. *Original note:* `api.py` allows `http://localhost:*`, `file://*` and `null`. Any web page can send `Origin: null` from a sandboxed iframe. In dev the port is fixed (47615), and in production it can be found by scanning a few ports. Several endpoints take filesystem paths from the request: `POST /documents` (reads any file into the library, then `/documents/{id}/file` serves it back), `POST /export` and `/documents/{id}/export` (write anywhere), and `/import` and the chat attachments (read anywhere). Together these let a malicious site in the user's normal browser read and write local files while the app runs. **Direction:** have Electron generate a random token per launch, pass it to the sidecar (argument or env) and to the preload, require it as a header on every request, and drop `null` and `file://` from the CORS regex. |
| 1.2 | Medium | **Path-taking endpoints trust the caller completely.** Even with a token, the renderer can make the backend read and write any path, so an XSS in rendered LLM output (Markdown, notes HTML, inline SVG diagrams) becomes file access. DOMPurify and `notehtml.clean` are the only barrier. **Direction:** have Electron's main process own the file dialogs and hand out short-lived "grants" (path → token) that the backend checks, or at least restrict writes to paths the user just picked in a dialog. |
| 1.3 | Medium | **Inline `<svg class="diagram">` from the model is allowed in notes.** SVG is a classic XSS route (`<foreignObject>`, `<use href>`, event attributes). Check that the DOMPurify config used for notes has the SVG profile and blocks `foreignObject` and external `href`s. |
| 1.4 | Low | `sandbox: false` in `BrowserWindow.webPreferences`. Context isolation is on and the preload API is small, which limits the damage, but a sandboxed renderer is the Electron default for a reason. The preload uses only `ipcRenderer`, `contextBridge` and `webUtils`, which are all available sandboxed, so this can probably be turned on. |
| 1.5 | Low | API keys sit in plain text in the SQLite `settings` table and the root `.env`. That's acceptable for a local app, but Electron's `safeStorage` (DPAPI on Windows) would keep them off disk in the clear. |
| 1.6 | Low | Study packs (new) are untrusted input. The import validates the manifest, never writes to member paths, checks file hashes and loads vectors without pickle. Text fields still end up rendered as Markdown/HTML, so they rely on the same sanitising as 1.2/1.3. |

## 2. Data integrity and durability

| # | Severity | Finding |
|---|---|---|
| 2.1 | ~~High~~ **Fixed 2026-11-03** | **There were no backups.** *Fixed:* `db.backup` copies the database with SQLite's backup API daily, before migrations, before a restore, and on demand (Settings → Maintenance → Backups, which also restores at the next start). Retention per kind is in `db.KEEP`. The original files and renders aren't copied. *Original note:* Everything (the library, generated content, attempts, annotations) lives in one `study.db` plus loose files. A bad migration, a disk problem or a buggy maintenance cleanup can't be undone. **Direction:** before applying migrations on startup, and daily, copy the database with SQLite's online backup API (`sqlite3.Connection.backup`) and keep the last N copies. Study packs now cover the library, but not artifacts or progress. |
| 2.2 | ~~High~~ **Fixed 2026-11-03** | **Migrations swallowed every error.** *Fixed:* the schema version is in `PRAGMA user_version`. The old statements (`LEGACY_MIGRATIONS`) tolerate only "duplicate column name", and new ones are numbered and transactional. A failure stops start-up with a message, and Electron now shows the backend's start-up error instead of timing out after 30 s. Data from a newer app version is refused. *Original note:* `db.init()` runs each `MIGRATIONS` statement and ignores *any* `OperationalError`, so a typo or a statement that fails for a real reason looks the same as "already applied". There's no schema version, so nothing records what has run. **Direction:** add a `schema_version` (`PRAGMA user_version`), apply numbered migrations once, and only tolerate "duplicate column" for the legacy `ALTER`s. |
| 2.3 | Medium | **A restart re-ingests from scratch.** Running jobs go back to `queued` on startup, and `pipeline.ingest` begins with `clear_document`. A crash during a 900-page textbook's embedding loses all its chunks and starts parsing again. Vision is kept only when `KEEP_VISION` is set. **Direction:** resume ingest jobs with `keep_vision=True`, and skip re-parsing when units already exist and the parser version matches. Embedding only fills missing vectors anyway. |
| 2.4 | Medium | **`PARSER_VERSION` has no effect.** It's stored per document, but nothing compares it, so parser improvements (e.g. version 2's SmartArt text) never reach older files unless they are re-ingested by hand. Maintenance could list "parsed with an older parser" the same way it lists stale embeddings. |
| 2.5 | Medium | **One SQLite connection guarded by one global lock.** Every request and every job worker queues on `db._lock`. Long transactions (import, relink, VACUUM, big ingests) block the UI's polling. WAL is on, so per-thread connections would allow concurrent readers. |
| 2.6 | Medium | **Exact dedupe depends on document ID order.** `scope_doc_ids` uses `id <= doc.id`, so which file "owns" a shared page depends on upload order, and deleting the owner leaves duplicates pointing at a unit that no longer exists (`duplicate_of` has no foreign key). Deleting a file doesn't relink the others the way a move now does (`pipeline.relink`). **Direction:** call `relink` on the old dependents in `delete_document`, as `move_document` now does. |
| 2.7 | Low | `practice_exams` and `snapshots` grow forever. `figure_cache` has no eviction. Maintenance doesn't show any of them. |

## 3. Likely to break with future upgrades

| # | Severity | Finding |
|---|---|---|
| 3.1 | **High** | **Behaviour specific to the model server is hard-coded.** `reasoning_effort ∈ low|medium|xhigh`, `chat_template_kwargs.enable_thinking`, the rejection of `json_schema`, and the `<think>` handling all match today's ninfer chat template. A new Qwen release or ninfer version that changes the template will break vision, chat and generation at once. **Direction:** move these into a "server profile" setting with a test (Settings → Test connections already exists) that checks each feature works, rather than assuming it. |
| 3.2 | **High** | **The OpenRouter defaults are free models by ID** (`google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3.5-embed-1b:free`). Free models disappear without notice. A fresh install that switches to OpenRouter will then fail with a 404. Fetch the list from `/models` and let the user pick, or fail with a clear message. |
| 3.3 | Medium | **Office XML internals.** `omml.py`, `parsers.graphic_text` (SmartArt and chart XPath) and the skipping of `mc:Fallback` reach into python-pptx/python-docx private XML. New Office versions or new python-pptx releases can change these quietly, so text simply goes missing. There are no tests over the real sample files (`spike/samples`). **Direction:** a small golden test that parses 3–4 representative files and compares unit counts, equation counts and key strings. |
| 3.4 | Medium | **`office_export.ps1` drives Microsoft Office over COM** with `-ExecutionPolicy Bypass`. Office updates, missing Office, or Group Policy can break it, and the only signal is the viewer's fallback layout. The 300-second timeout per file is long. Surface the failure reason in Maintenance. |
| 3.5 | Medium | **The front-end dependencies use caret ranges with known breaking majors ahead.** `pdfjs-dist ^4` (v5 changes the worker/ESM setup and the text layer API used in `SourceView`/`annotate`), `react ^18` (19 changes ref and StrictMode behaviour the code relies on), `electron ^33` (now out of support; each major changes Chromium), and `vite ^5`. `package-lock.json` protects today's install, but `npm update` doesn't. |
| 3.6 | Medium | **Python is pinned to `>=3.12,<3.13` with open-ended lower bounds** on everything else (`pymupdf>=1.24`, `numpy>=2.0`, `fastapi>=0.115`). PyMuPDF changes behaviour between minors (text extraction flags, `get_images`). `uv.lock` protects today's build, but a `uv lock --upgrade` can change parsing output silently. Add upper bounds on PyMuPDF and python-pptx. |
| 3.7 | Medium | **Starlette's TestClient warns that `httpx` support is deprecated** (seen in every test run). The tests will break on a future Starlette release. |
| 3.8 | Low | `--parent-pid` watching uses `ctypes.windll`, so the sidecar is Windows-only. That's intended, but nothing guards it besides `os.name == "nt"`. |

## 4. Architecture and maintainability

| # | Severity | Finding |
|---|---|---|
| 4.1 | Medium | **Very large modules mix several concerns.** `SourceView.tsx` (~860 lines: viewer, toolbar, outline, minimap, snapshot), `chat_api.py` (~760: routes, prompt building, attachments, tools, SSE), `annotate.tsx` (~590), `ArtifactViewer.tsx` (~540). These are hard to change safely and are where regressions cluster. Split along the seams that already exist (prompt building versus HTTP in `chat_api`; toolbar, page and minimap in `SourceView`). |
| 4.2 | Medium | **Five stacked CSS layers** (`styles.css` → v2 → v3 → v4 → v5), each re-styling the same selectors. Which rule wins depends on file order and specificity, and several `!important`s exist to settle fights. A change to `.side` or `.btn` has to be checked in four files. **Direction:** merge the layers into component-scoped files (or CSS modules) once the visual design settles, keeping the tokens in one place. |
| 4.3 | Medium | **Polling everywhere.** About 11 `usePoll` loops (jobs 1.5 s, file lists 2.5 s, library 3 s, documents 4 s, and more) each hit SQLite through the global lock (2.5). With a subject open, around 2–3 requests a second are steady background load, and it scales with open panes. **Direction:** one SSE "changes" stream from the backend (job and document updates) that the hooks subscribe to. |
| 4.4 | Medium | **Search loads every vector on each query.** `search.search` reads and stacks every chunk's BLOB in scope for each question (and `projection.py` does the same for the cloud). A subject with two textbooks has ~4,000 chunks × 2,560 floats ≈ 40 MB of decoding per question, and it grows linearly. **Direction:** cache a per-scope matrix in memory, invalidated by a document `updated_at`, or use `sqlite-vec`. |
| 4.5 | Medium | **One job worker per lane, strictly FIFO.** A 900-page vision job blocks every other vision job, including a 3-page upload, for hours. Generation waits behind marking, and so on. There are no priorities and no fairness. (Pausing is new; scheduling hasn't changed.) |
| 4.6 | Low | **No React error boundary.** An exception in any view (e.g. malformed generated JSON in `ArtifactViewer`) blanks the whole window. Wrap each centre pane and viewer. |
| 4.7 | Low | **26 empty `catch {}` / `.catch(() => {})` in the front end and 24 broad `except Exception` in the backend** (5 of them `pass`). Some are deliberate (storage unavailable, embedding offline), but failures in places like figure resolution or icon upload vanish without trace. Log them at least (the backend has no logging setup; it uses `print` and `traceback.print_exc`). |
| 4.8 | Low | `api.ts` is one ~400-line client with inline types. It's fine for now, but types for backend rows are written by hand twice (Python dicts and TS interfaces) with nothing checking that they agree. Generating them from FastAPI's OpenAPI schema would catch drift. |
| 4.9 | Low | Persistence is split between the database (`ui_state`), per-machine `localStorage` (appearance, sidebar widths, chat corner and size, collapsed groups) and `userData` JSON (window chrome and bounds, new). A study pack or a new PC carries none of the UI state. Note this somewhere for the user. |
| 4.10 | Low | `trash/` and `spike/` sit in the repo root. `spike/samples` holds large real files. Make sure they're git-ignored or moved out, so they don't bloat clones and packaging. |

## 5. Testing

| # | Severity | Finding |
|---|---|---|
| 5.1 | Medium | **Backend coverage is uneven.** There are tests for providers, projection, study API, vision maintenance, moves/scope/pause and study packs (64 tests). Nothing covers `parsers.py`, `omml.py`, `generate.py` (allocation, exam blueprint, n-gram copy check), `chat_api.py` (prompt building, tool forms, SSE), `render.py`, `figures.py` or `annotations.py`. These are the riskiest modules (3.1, 3.3). |
| 5.2 | Medium | **No front-end tests at all**: not even a smoke render of each view, `Markdown.tsx`'s `$` pairing (which the vision audit relies on matching), or `plot.ts`. |
| 5.3 | Medium | **No CI.** `tsc`, `vite build` and `pytest` only run when someone remembers. A GitHub Actions workflow on Windows running all three would catch most regressions. |
| 5.4 | Low | Tests share one session database (`conftest.py`), and several clean up by hand (`DELETE FROM jobs`). Order-dependent failures are possible as the suite grows. A per-test transaction or a fresh database per module would isolate them. |

## 6. Documentation gaps

| # | Severity | Finding |
|---|---|---|
| 6.1 | Medium | **No user-facing description of the data layout and recovery steps:** where the database, files, renders and assets live, what is safe to delete, how to move to a new PC (now: study packs plus copying `%APPDATA%\Apollo Study`), and what to do if the backend won't start. |
| 6.2 | Medium | **No API reference.** FastAPI serves `/docs`, but the endpoints, the SSE event types and the job/document status machines (`queued → parsing → embedding → vision → ready`, `failed`, `cancelled`) are only described in code and `CLAUDE.md`. A short state diagram would prevent bugs like the exam scope error. |
| 6.3 | Low | The study pack format (`packages.py` docstring) is documented only in code. If classmates share packs, a versioned spec file (`docs/STUDY_PACK.md`) helps keep future versions compatible. |
| 6.4 | Low | `PLAN.md` and `UI_ROADMAP.md` mix decisions, measurements and history. A dated "decisions" log, separate from the plan, would show what is current. |
| 6.5 | Low | Settings have no in-app explanations for advanced keys (`vision_big_image_area`, `chunk_max_slides`, `embed_batch`, …). They live in `config.py` comments only. |

## 7. Product and UX observations

- **Scope fallbacks were a source of confusing errors** (fixed now: whole-subject scopes use the reference library when topics are empty, and the form names the actual reason). Similar empty-state logic exists in chat (`chat_api._system_prompt`), search and the cloud. Review it with the same "what does the user see when X is empty?" question.
- **Moving files used to re-ingest everything** (fixed: `pipeline.relink`). Deleting a file still doesn't relink the files that depended on it (2.6).
- **Vision runs per document, in upload order**, so a textbook uploaded first delays every later file's vision by hours (4.5). A "run this next" action in the jobs panel would help.
- Generation and marking can't be resumed: cancelling a 20-minute exam job loses everything made so far, because sections are only written at the end.

---

### Suggested order

1. ~~1.1 (token auth and the CORS fix)~~ done.
2. ~~2.1 + 2.2 (backups, versioned migrations)~~ done.
3. 5.3 + 3.3 (CI with golden parser tests): make upgrades safe.
4. 4.4 + 4.3 (vector cache, change stream): performance as libraries grow.
5. 4.1 / 4.2 refactors when next touching those areas.
