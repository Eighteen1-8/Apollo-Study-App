# Study (offline AI study app)

Electron + React frontend, Python (FastAPI) sidecar backend, local models only. See [PLAN.md](PLAN.md).

## Requirements
- ninfer serving `qwen3.8-27b` (vision on, C=1) at `http://127.0.0.1:8080/v1`
- LM Studio serving `text-embedding-qwen3-embedding-4b` at `http://127.0.0.1:8989/v1`
- Node 20+, [uv](https://docs.astral.sh/uv/)

Endpoints, model ids and keys can be changed in the app under **Settings**. On first run they're seeded from the repo's `.env`.

## Setup (once)
```
cd backend && uv sync
cd ../app && npm install
```

## Run
```
cd app
npm run dev      # Vite + Electron with hot reload (backend on 127.0.0.1:47615)
npm start        # production build of the UI + Electron
```
Electron starts the backend itself and stops it on exit. App data (database, copied files, vision images) lives in `%APPDATA%\Study\data`.

## Using it
- **Left icon bar**: one tile per subject (right-click to change colour, letters, emoji or image), + to add, the background-jobs bar, and settings.
- **Subject workspace**: generated content on the left (grouped by topic), chat in the middle, and to-dos, textbooks and topics on the right. Hover a topic for upload/create; right-click anything for more.
- **Chat**: pick a topic and a reasoning level (Off / Low / Medium / XHigh; levels set in Settings). Qwen quotes and cites your material; click a citation to open that slide/page. Opening a file floats the chat bottom-left (collapse with ▾).
- **Quizzes / flashcards** open fullscreen. Quizzes: one question per page, Check, then a results screen where Qwen reviews your answers and suggests topics for your to-do list. Flashcards: ✓ / ✗ under each card; ✗ cards are passed to the chat tutor as things you're struggling with.
- **Browser preview of the UI** (dev only): `http://localhost:5173/?backend=PORT` points the page at a backend on another port.

## Layout
- `backend/studyapp/`: `parsers.py` (PPTX/DOCX/PDF/text/images, native Python), `omml.py` (equations → LaTeX), `dedupe.py` (exact, deterministic), `pipeline.py` (parse → dedupe → chunk → embed → vision notes), `jobs.py` (persistent queue), `search.py` (BM25 + vectors), `context.py` (material Qwen reads), `generate.py` (flashcards/quiz/notes/cheat sheet/exam + marking), `chat_api.py` (streaming chat + tool forms), `api.py`
- `app/electron/`: main process (spawns backend, blocks all non-localhost traffic), preload
- `app/src/`: React UI
- `spike/`: Phase 0 experiments
