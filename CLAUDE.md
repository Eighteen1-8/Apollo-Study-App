# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Offline, private AI study app for Windows: Electron + React frontend (`app/`), Python FastAPI sidecar (`backend/`), local models only. `PLAN.md` holds the design, decisions and Phase 0 measurements; `README.md` covers usage.

## Commands

```bash
# one-time setup
cd backend && uv sync
cd app && npm install

# run (from app/): Vite + Electron with HMR; Electron spawns the backend itself
npm run dev
npm start            # production UI build + Electron

# checks (from app/) — there is no test suite or linter yet
npx tsc --noEmit
npx vite build

# backend on its own (from backend/), e.g. against a throwaway data dir
.venv/Scripts/python -m studyapp.main --port 47616 --data-dir <dir>
```

- Dev backend port is **47615** (8765 is taken by Thunderbird on this machine). In dev, Electron reuses a healthy backend already on 47615; otherwise it spawns one with `--parent-pid` so it exits when Electron dies.
- If the user has `npm run dev` open, port 47615 and Vite's 5173 are theirs (their real data in `%APPDATA%\Study\data`). Test against a separate backend port and open the UI at `http://localhost:5173/?backend=PORT` instead of killing their processes. Backend code changes need their app restarted; Vite hot-reloads the UI into their running app immediately.
- `spike/` holds Phase 0 experiment scripts (`spike/samples/Physics` has real sample files; they're large, so read summaries, not contents).

## External services

- **Qwen** via ninfer, OpenAI-compatible, `http://127.0.0.1:8080/v1`, model `qwen3.8-27b`, 100k context, vision on, **concurrency 1**.
  - Rejects `response_format: json_schema`. Structured output uses `llm.chat_json` (schema in the prompt, pydantic validation, repair retries).
  - Supports native `tools` (also streamed).
  - Reasoning is `reasoning_effort` ∈ `low | medium | xhigh` only (the chat template raises on anything else). "off" means `chat_template_kwargs.enable_thinking=false`. See `llm.reasoning_fields`.
  - Prefix caching works: keep a scope's system prompt (rules + material) byte-identical across calls and put anything variable after it.
- **Embeddings**: LM Studio `http://127.0.0.1:8989/v1`, `text-embedding-qwen3-embedding-4b`, on CPU. Queries get the Qwen3 instruction prefix (`llm.QUERY_INSTRUCT`); documents don't. LM Studio also lists `qwen3.8-27b`; never call it (loading it exhausts RAM).
- Endpoints and keys live in the DB settings table, seeded on first run from the gitignored root `.env`. The UI never receives API keys back (they're masked).

## Architecture

**Data flow.** Upload → `pipeline.ingest` → parse into *units* (slide/page/section) → exact dedupe → chunk → embed. Then a separate lane runs `pipeline.run_vision`, which writes Qwen's vision notes onto units.

**Ingest rules (user requirement: quality over speed):**
- Deduplication is **deterministic and exact only**, never model-judged (`dedupe.py`: SHA-256 over text + image hashes, scoped per topic or per subject reference library; PDF header/footer lines removed only on character-exact repetition).
- **Only extracted text is embedded.** Vision notes stay on `units.vision_notes` and are joined in when building context for Qwen (`context._unit_block`), never embedded.
- Equations: `omml.py` converts Office Math to LaTeX. `mc:Fallback` branches are skipped in both parsing and equation counting (they duplicate content).
- Text always comes from the native parsers (python-pptx/python-docx, incl. SmartArt and chart text via `parsers.graphic_text`).
- Viewing: `render.py` has Microsoft Office (COM via `office_export.ps1`) or LibreOffice export each .pptx/.docx to an exact PDF once (`<data>/renders/<sha>.pdf`); the viewer shows it with pdf.js and slide images for vision come from it. Office is only quit if the script started it. Without a converter, `viewer.py` HTML layouts and `parsers.compose_slide` are the fallback. Word sections ≠ PDF pages: `documents.render_map` maps sections to [page, y]; annotations made on the copy carry `data.space='pdf'`.

**Jobs** (`jobs.py`): a persistent SQLite queue with lanes `ingest` (CPU), `vision` and `generate` (types `generate` and `mark`). All Qwen calls, including chat, go through the semaphore in `llm._gate()` sized by `llm_concurrency`. Running jobs are requeued on restart. Cancellation is cooperative: `job.check()` raises `pipeline.Cancelled`.

**Context for Qwen** (`context.py`): `material_groups()` packs a scope's documents into groups of at most ~60% of the context window.
- Chat: if a scope fits in one group, the whole material goes in the system prompt (full-context mode). Otherwise retrieval (`search.py`: FTS5 BM25 + numpy cosine over BLOB vectors, RRF) adds excerpts to the latest user turn.
- Textbook (`kind='reference'`) passages are always retrieved per request and appended after the cached prefix.
- Flashcard ✗ ratings are appended *after* the material (`study_api.struggling_cards`) so the prefix cache still hits.

**Generation** (`generate.py`): coverage-driven, not top-k. Item counts are allocated across every document section in proportion to size (`_allocate`), with one call per section sharing the group's system prompt.
- Exams: parse the practice exam (never embedded; stored in `practice_exams`) → `Blueprint` → per-part generation in the blueprint's exact structure → a deterministic n-gram check drops questions copied from the practice exam.
- Marking (`run_marking`): MCQ against the key exactly; written answers by Qwen against the rubric.
- Notes and cheat sheets are HTML built from a fixed component set (`notehtml.DESIGN`; styled by `.nb` in `styles-v3.css`), cleaned by `notehtml.clean` (falls back to Markdown). Sections store `html` + `figures` (older ones `markdown`).
- Figures: Apollo (the user-facing name for the model) writes `[[figure: file · label | description]]` from vision notes; `figures.py` finds candidates in the page's PDF structure, lets the vision model pick a numbered box, crops it, caches in `figure_cache`. Chat resolves tags after the stream ends (the LLM gate is free then). Graphs are ` ```plot ` JSON (chat) / `<pre class="plot">` (notes), drawn by `components/plot.ts`; inline `<svg class="diagram">` is allowed.

**Chat ↔ content creation** (`chat_api.py`): the model's tool calls (or UI quick actions) create a `messages` row with `role='tool'` holding a form (`meta.status='form'`). Submitting it creates an `artifacts` row plus a `generate` job, and the message turns into a progress card. Chat streams as SSE (`user | status | reasoning | delta | assistant | tool | error | end`).
- Citations: the system prompt makes Qwen cite as `[[filename · unit label]]`. `Markdown.tsx` turns these into `a.cite` links, `SubjectView.openCitation` resolves the filename to a document, and `DocumentView.matchUnit` finds the slide or page.

**Backend modules:** `api.py` (documents, settings, jobs, search) plus routers `chat_api.py` and `study_api.py` (icons, library, card ratings, quiz review, to-dos). Schema lives in `db.py`: `SCHEMA` uses `CREATE IF NOT EXISTS`, and new columns/tables go in `MIGRATIONS` (each statement is attempted and errors are ignored).

**Frontend:** no router library. `App.tsx` holds a `Route` union (`home | subject | settings`).
- `SubjectView` is a three-column workspace: `LibraryPanel` (generated content), the centre (`ChatView`, or `DocumentView` with the chat floating), and `ResourcePanel` (to-dos, textbooks, topics).
- All dialogs and context menus go through `components/overlay.tsx` (`useOverlay().menu/prompt/confirm`), because Electron has no `window.prompt`.
- `api.ts` is the single typed client. Styles are layered (`styles.css` tokens → `styles-v2.css` → `styles-v3.css`).
- Electron (`app/electron/main.cjs`) blocks every non-localhost request (the app must stay fully offline). The preload exposes `window.studyApp` (backend URL, file dialog, `pathForFile` for drag-and-drop). React StrictMode double-runs effects, so side-effecting effects must claim work synchronously before awaiting (see the launch guard in `ChatView`).
