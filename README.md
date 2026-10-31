# Apollo (offline AI study app)

Electron + React frontend, Python (FastAPI) sidecar backend. Local models by default; online models via OpenRouter are optional.

## Requirements
- OpenAI compatible API (with vision and embedding enabled)
- Node 20+, [uv](https://docs.astral.sh/uv/)

Endpoints, model ids and keys can be changed in the app under **Settings**. On first run they're seeded from a `.env` file in the repo root — copy `.env.example` and fill it in.

### Online models (optional, off by default)
Settings → **Model provider** switches chat/generation and embeddings to [OpenRouter](https://openrouter.ai) independently. Put `OPENROUTER_API_KEY` in `.env` (never commit it). **Anything sent to an online model leaves your computer: it is logged on external servers and may be used for training or other purposes.** The app asks before switching and shows a globe badge in the left bar while online models are on. Free models are often rate limited; requests are retried with backoff.

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
Electron starts the backend itself and stops it on exit. App data (database, copied files, vision images) lives in `%APPDATA%\Apollo Study\data`.

## Tests
```
cd backend
uv run pytest            # offline unit tests (HTTP mocked, throwaway data dir)
uv run pytest --online   # also live OpenRouter checks (sends synthetic test text only)
```

## Using it
- **Left icon bar**: one tile per subject (right-click to change colour, letters, emoji or image), + to add, the background-jobs bar, and settings.
- **Subject workspace**: generated content on the left (grouped by topic), chat in the middle, and to-dos, textbooks and topics on the right. Hover a topic for upload/create; right-click anything for more.
- **Chat**: pick a topic and a reasoning level (Off / Low / Medium / XHigh; levels set in Settings). Qwen quotes and cites your material; click a citation to open that slide/page. Opening a file floats the chat bottom-left (collapse with ▾).
- **Quizzes / flashcards** open fullscreen. Quizzes: one question per page, Check, then a results screen where Qwen reviews your answers and suggests topics for your to-do list. Flashcards: ✓ / ✗ under each card; ✗ cards are passed to the chat tutor as things you're struggling with.
- **Browser preview of the UI** (dev only): `http://localhost:5173/?backend=PORT` points the page at a backend on another port.

## Layout
- `backend/studyapp/`: `parsers.py` (PPTX/DOCX/PDF/text/images, native Python), `omml.py` (equations → LaTeX), `dedupe.py` (exact, deterministic), `pipeline.py` (parse → dedupe → chunk → embed → vision notes), `jobs.py` (persistent queue), `search.py` (BM25 + vectors), `context.py` (material Qwen reads), `generate.py` (flashcards/quiz/notes/cheat sheet/exam + marking), `chat_api.py` (streaming chat + tool forms), `api.py`
- `app/electron/`: main process (spawns backend, blocks all non-localhost traffic from the UI; online model calls go through the backend), preload
- `app/src/`: React UI
- `spike/`: Phase 0 experiments

## Note
- FULLY vibecoded btw (but it works tho)