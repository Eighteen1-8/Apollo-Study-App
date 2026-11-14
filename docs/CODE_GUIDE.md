# Code guide

How Apollo's code is laid out, the conventions it relies on, and how to make the common kinds of change. The
[README](../README.md#architecture) has the big picture; `CLAUDE.md` in the repo root has the finer design notes for
each area (read it before changing one).

- [Repository map](#repository-map)
- [Working on it](#working-on-it)
- [The backend](#the-backend-backendstudyapp)
- [The frontend](#the-frontend-appsrc)
- [Electron](#electron-appelectron)
- [Conventions that matter](#conventions-that-matter)
- [How to…](#how-to)
- [Tests](#tests)

## Repository map

```
backend/
  studyapp/          the FastAPI backend (Python 3, run with uv)
  tests/             pytest; fixtures/ and golden/ hold sample Office files and their expected parse
  studyapp-backend.spec   PyInstaller spec for the packaged backend
app/
  electron/          main.cjs (main process), preload.cjs (the bridge to the page)
  src/               the React UI (TypeScript, Vite)
  tests/             unit/ (Vitest), e2e/ (Playwright + a fake model server), electron/, css/, pdf/
  scripts/check.mjs  `npm run check`: every check in one go
  assets/            bundled spell-check dictionaries, icons
docs/                this guide, DATA.md, ERRORS.md (generated), plans and analysis
spike/               Phase 0 experiments and sample files (not part of the app)
PLAN.md              design decisions and measurements
```

## Working on it

```bash
cd backend && uv sync          # once
cd app && npm install          # once
cd app && npm run dev          # Vite (hot reload) + Electron; Electron starts the backend on 127.0.0.1:47615
```

- **UI changes** hot-reload into the running window. **Backend changes** need the app restarted (close it and run
  `npm run dev` again).
- **A throwaway data folder** keeps your real data out of it: `APOLLO_DATA_DIR=<dir> npm run dev`, or run the backend
  on its own and open the UI in a browser:

  ```bash
  cd backend
  .venv/Scripts/python -m studyapp.main --port 47616 --data-dir <dir>
  ```

  then `http://localhost:5173/?backend=47616&token=<contents of <dir>/backend-token>` (with `npm run ui` running).
- The backend log is `<data>/logs/backend.log`; the renderer's console is in Electron's DevTools (View → Toggle Developer Tools, Ctrl+Shift+I).
- `npm run check` (from `app/`) runs types, build, unit tests, backend tests, the Playwright run and the Electron smoke
  run. `npm run check -- --quick` skips the build and browser runs.

## The backend (`backend/studyapp`)

One module per area. Entry point: `main.py` (arguments, logging, start-up tasks, then uvicorn serving `api.app`).

| Area | Modules |
|---|---|
| HTTP API | `api.py` (the app, auth, documents, subjects, topics, settings, jobs, search) and routers: `chat_api.py`, `notes_api.py`, `study_api.py`, `annotations.py`, `projection.py`, `maintenance.py`, `packages.py`, `events.py` |
| Storage | `db.py` (schema, migrations, `q`/`q1`/`ex`/`tx`, settings, backups), `config.py` (paths, default settings), `secret_store.py` (DPAPI for keys), `grants.py` (which files the backend may read or write) |
| Reading files | `parsers.py` (PPTX/DOCX/PDF/text/images → units), `omml.py` (equations → LaTeX), `dedupe.py` (exact duplicates), `chunker.py`, `pipeline.py` (ingest, re-embed, vision notes, `relink` after moves), `render.py` + `office_export.ps1` (exact PDF copies of Office files), `viewer.py` (fallback layouts), `vision_audit.py` (checking vision notes) |
| Jobs | `jobs.py` (the queue, its three lanes and workers; `track` for interactive work) |
| Models | `llm.py` (every call to a model server: chat, streaming, JSON output, embeddings, the concurrency gate, pausing, server probing) |
| Finding material | `search.py` (BM25 + vectors), `context.py` (what the model reads for a scope), `citations.py` |
| Making things | `generate.py` (all generated content and exam marking), `notehtml.py` (the HTML notes are built from), `figures.py` (figures cut from the student's files), `review.py` (checking/revising notes), `questions.py` (each subject's example questions), `examples.py` (the example subject) |
| Chat | `chats.py` (the chat list), `chat_reply.py` (one turn, streamed), `chat_prompt.py` (what the model is sent), `chat_tools.py` (tool specs and read-only tools), `chat_files.py` (files attached to one message) |
| Other | `docx_export.py` (Word export), `errors.py` (error codes), `log.py`, `events.py` (change stream) |

**Request flow.** A route reads with `db.q`/`db.q1` (a per-thread read-only connection, never blocked by writes) and
writes with `db.ex` or `with db.tx():` (the single writer). Anything slow or model-bound is queued with
`jobs.enqueue(type, document_id=…, ref_id=…)` and the route returns at once; the UI hears about progress through
`/events`.

**Jobs.** `jobs.LANES` maps each lane to its job types; `_run(lane)` takes the highest-priority queued job and calls its
handler. Handlers receive a `Job` with `note(message)`, `update(progress, message)`, `check()` (raises when cancelled)
and `should_yield()`. A failing job is stored as "plain message [APO-…]".

**Model calls.** Always through `llm.py`: `llm.chat`, `llm.chat_stream`, `llm.chat_json(messages, PydanticModel)` for
structured output (the schema goes in the prompt and the reply is validated and repaired), `llm.embed`. Read
endpoints and model names only with `llm.llm_cfg()` / `llm.embed_cfg()`, never from the settings directly (they switch
between local servers and OpenRouter).

## The frontend (`app/src`)

| Path | What it is |
|---|---|
| `main.tsx`, `App.tsx` | Start-up and the top level: the `Route` (home, subject, settings), the side bar, global shortcuts, the setup wizard and tour |
| `api.ts` | The only HTTP client: one typed function per endpoint, and the response interfaces |
| `views/` | Screens: `Home`, `SubjectView` (the workspace), `ChatView`, `SourceView`/`DocumentView` (file viewer), `ArtifactViewer` + `artifacts/` (flashcards, quiz, exam, notes, mind map), `NoteEditor`, `SettingsView`, `MaintenanceView`, `ShareView` |
| `views/subject/` | The workspace's parts: `viewState.ts` (what the centre shows, a reducer), `useChatDock.ts` (where the chat sits), `StudyPanel`, `MakeContent`, `GettingStarted` |
| `views/chat/`, `views/resources/` | The chat's parts (composer, messages, tool forms, slash commands) and the right side bar's (topics, files, notes, to-dos, file search) |
| `components/` | Shared pieces: `overlay.tsx` (every dialog and menu), `toast.tsx`, `Icon.tsx`, `Markdown.tsx`, `EmbeddingCloud.tsx`, `FindBar.tsx`, `CommandPalette.tsx`, `SetupWizard.tsx`, `AppearancePickers.tsx`, `reorder.ts` (drag to reorder) … |
| State helpers | `hooks.ts` (`usePoll`), `events.ts` (the `/events` stream), `undo.ts` (undo/redo), `prefs.ts` (per-machine UI state), `theme.ts` (appearance, mode, animation speed), `terms.ts` (user-facing words), `chatStreams.ts` (chat replies outside React), `log.ts`, `errors.ts` |
| `styles/` | One cascade in five files: `1-base` (tokens, building blocks) → `2-components` → `3-layout` → `4-themes` → `5-features`. Later files may restyle earlier ones |

**Data in components.** Load with `usePoll(() => api.something(id), ms, [deps], ['topic'])`: it reloads when the
backend reports that topic changed (topics are listed in `events.py`) and falls back to a slow poll. Don't add plain
intervals.

## Electron (`app/electron`)

- `main.cjs`: picks the port (47615 in dev, a free one otherwise), creates the token, spawns the backend and waits for
  `/health` (showing any start-up error with its log path), blocks every request that isn't to localhost, signs file
  paths from dialogs and drops, handles printing to PDF, screenshots, spell check (bundled dictionaries only) and the
  window's title-bar colours.
- `preload.cjs`: exposes `window.studyApp` to the page (backend URL and token, file dialogs, grants, spell check, zoom).

## Conventions that matter

- **Offline by default.** Electron blocks non-localhost requests; nothing may download at run time (spell-check
  dictionaries, icons and the PDF viewer are bundled). Online models only go through the backend when the student turns OpenRouter on.
- **Exact, deterministic deduplication.** Never let a model decide what is a duplicate (`dedupe.py`).
- **Errors have codes.** Raise `errors.AppError("APO-AREA-NNN", technical, plain)`, or let `errors.classify` map an
  exception. The UI shows codes with `ErrorText`. A new code needs a catalogue entry and a regenerated `docs/ERRORS.md`.
- **The model's prompt prefix stays byte-identical** within a scope (rules + material first, anything variable after),
  so the server's prefix cache works.
- **User-facing words** for the machinery come from `terms.ts` (standard vs advanced mode), not hard-coded strings.
- **Dialogs and menus** go through `useOverlay()` (Electron has no `window.prompt`). **Icons** come from `<Icon name>`;
  never use text symbols as icons; icon-only buttons need a `title` or `aria-label`.
- **Deleting**: things that can be undone (chats, content, notes, to-dos, files) go at once with Undo in a toast and on
  Ctrl+Z; things that can't (topics, subjects, folders, backups) ask first.
- **Logging**: `logging.getLogger(__name__)` in Python (never `print`), `logError` in the UI.
- **React StrictMode** runs effects twice in dev: an effect with side effects must claim its work synchronously before
  awaiting anything.

## How to…

### Add an API endpoint
1. Add the route to the router for its area (or `api.py`). Validate the body with a pydantic model; raise
   `HTTPException(status, "plain words")` (prefix a code when the status alone is too vague).
2. Add a typed function and the response interface to `app/src/api.ts`.
3. If the response shape is new, extend `backend/tests/test_api_contract.py`, which checks `api.ts` interfaces against
   real responses.
4. If the change should refresh open panels, make sure `events.py` notices it (its topic signatures read the tables
   you wrote to).

### Add a database column or table
Append a numbered entry to `db.MIGRATIONS`, for example `(12, ["ALTER TABLE subjects ADD COLUMN …"])`, with a comment
saying what it is for. Migrations run once in a transaction at start-up (after a backup) and are recorded in
`PRAGMA user_version`. Never edit an existing migration or `LEGACY_MIGRATIONS`. Then use the column; `SELECT *`
routes return it automatically, so update `api.ts` too.

### Add a setting
1. Add its default to `config.DEFAULT_SETTINGS` (and to `config.SECRET_KEYS` if it is a key, so it is encrypted and
   masked).
2. Read it with `db.setting("name")`.
3. Show it in `views/SettingsView.tsx`: a `Field` in the right group, or its own control. Technical settings belong
   behind advanced mode (`useAdvanced()` / the `Expert` wrapper).

Appearance settings (theme, animation speed, text size…) are per-machine and live in `theme.ts`, not the database.

### Add a background job type
1. Add the type to its lane in `jobs.LANES` (the lane decides which model it waits for).
2. Handle it in `jobs._run`, and in `_mark_owner` if a row (artifact, document…) should show the failure.
3. Queue it with `jobs.enqueue("type", ref_id=…, label=…)`; `enqueue` will not queue a second identical job.
4. Name it in `components/JobsPanel.tsx` (`USES`, `TYPE_NAME`, `TYPE_PLAIN`, `VERB`) so the jobs list reads well.

`questions.py` is a small, complete example.

### Add an error code
Add an entry to `errors.CATALOGUE` (title, plain message, what to do), raise it with `AppError`, then regenerate the
document:

```bash
cd backend
.venv/Scripts/python -m studyapp.errors > ../docs/ERRORS.md
```

A test fails if `docs/ERRORS.md` is out of date.

### Add a kind of generated content
1. Backend: write `gen_<type>(art, params, groups, prog)` in `generate.py` returning the content as a dict, and register
   it in `generate.GENERATORS`. Use `_per_section` for coverage-driven items and `llm.chat_json` with a pydantic model.
2. Chat: add a `create_<type>` tool to `chat_tools.py` if Apollo should offer it.
3. UI: add the type to `ArtifactType` in `api.ts`, to `MAKE_TYPES` in `views/subject/MakeContent.tsx`, an icon in
   `LibraryPanel.TYPE_ICON`, and a viewer in `views/artifacts/` wired into `ArtifactViewer.tsx`.

### Add a chat tool
Add the spec to `chat_tools.py`. A tool that creates content becomes a form message (see `chat_api.py`); a read-only
tool goes in `READ_TOOLS` and its result is fed back to the model within the same turn.

### Add a slash command
Add it to `COMMANDS` in `components/slashCommands.tsx` (name, arguments, summary) and handle it in
`views/chat/commands.tsx` (`runCommand`). Slash commands never reach the model.

### Add a theme
1. Add it to `THEMES` in `theme.ts` (id, name, blurb, swatch colours, `light: true` for a light theme) and to the
   `ThemeId` type.
2. Add a `:root[data-theme="<id>"] { … }` block in `styles/4-themes.css` setting at least `--bg`, `--bg-elev`,
   `--bg-elev-2`, `--bg-hover`, `--border`, `--border-strong`, the three text colours, `--accent`, `--minibar-bg`, the
   `--glow-*` colours and `--cloud-star`. A light theme starts from the shared `:root[data-tone="light"]` block, so it
   only overrides what differs.
3. Settings and setup pick it up from `THEMES`.

### Add a screen or panel
- A new top-level screen is a new `Route` kind in `App.tsx` (there is no router library).
- Something inside a subject goes into `SubjectView`: what the centre shows is decided in `views/subject/viewState.ts`;
  side-bar parts live in `views/resources/` or `LibraryPanel.tsx`.
- Wrap a pane in `ErrorBoundary` so a failure stays local, load data with `usePoll`, and record undoable changes with
  `undoable({ label, undo, redo })`.

### Change styles
Find every rule for a selector across all five style files before changing it (later files restyle earlier ones).
Colours are tokens (`var(--accent)`, `var(--text-dim)` …) so all nine themes follow. For a reorganisation, compare
computed styles before and after with `app/tests/css/capture.mjs`.

### Change the model prompts
The chat's rules and style are in `chat_prompt.py` (the editable default is shown in Settings → Chat tutor, advanced
mode); generation prompts are next to each generator in `generate.py`. Keep the material-bearing system prompt identical
between calls and put variable text after it.

## Tests

| Command (from `app/`) | What it covers |
|---|---|
| `npx tsc --noEmit` | Types |
| `npm test` | Vitest unit tests in `tests/unit` (pure functions, reducers, undo, citations…) |
| `cd ../backend && uv run pytest` | Backend: API, parsing (golden Office files), jobs, citations, packages… with HTTP to models mocked and a throwaway data folder (`tests/conftest.py`) |
| `npm run test:e2e` | Playwright against a throwaway backend and `tests/e2e/fake_llm.py` (a fake model server), using the installed Edge |
| `npm run test:electron` | The real Electron app: window, backend, offline blocking, spell check, printing |
| `npm run check` | All of the above |

No model or key is needed for any of them. When you add a feature, add a backend test next to the closest existing
one (`tests/test_<area>.py`) and, for UI behaviour, a Playwright step in `tests/e2e/features.spec.ts`.
