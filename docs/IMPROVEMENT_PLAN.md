# Structural and performance improvement plan

Written 2026-11-07, after the 20 UI/chat fixes (`FIX_PLAN.md`). Implemented the same day except P7: see **Status** at the end.
It builds on `APP_ANALYSIS.md` (2026-11-03), whose fixed items aren't repeated. Numbers were measured on a copy of
the real library: 7 subjects, 315 files, 11,292 embedded chunks of 4,096 dimensions, 279 MB database, textbooks up
to 917 pages.

**Has to** means it costs the student something today (a frozen or hot machine, lost edits) or will break soon.
**Should** means real but not urgent.

---

## Has to: performance

### P1. The knowledge cloud's projection takes 6 seconds and is redone after every change
`backend/studyapp/projection.py`
- **Measured:** 6.3 s for the home page cloud, 5.5 s for Methods, 2.6 s for Computing. Almost all of it is
  `np.linalg.svd` on a 3,000 × 4,096 matrix (5.7 s alone), and only 3 components are used.
- **Why it hurts:**
  - The cache key is the chunk count and the newest chunk id, so any chunk change throws it away.
  - During an ingest, chunks change constantly. Every open cloud refetches 4 s after each `documents` event, plus a
    60 s fallback.
  - So the backend runs a 6 s full-CPU SVD over and over while it is also parsing and embedding.
  - The cache is in memory only, so each app start pays 6 s before the home page cloud appears.
  - Each recompute can flip axis signs, so the cloud's layout can jump between visits.
- **Fix:**
  1. Compute only the top 3 components: a randomized range finder in float32, fitted on at most about 1,500
     sampled rows, then project all points. A first test took 0.8 s against 5.7 s, and should drop further with
     the smaller fit.
  2. Fit the axes once per (model, scope) and store them. New chunks are projected onto the stored axes (one small
     matrix product), so an ingest only adds points and the layout stays put. Refit only when the scope has grown
     by more than about 25%, or from a "Re-arrange" button.
  3. Save the projection (axes plus each chunk's x/y/z, in a small table or an `.npy` next to the database), so a
     restart is instant.
  4. Fix the sign of each axis (for example, largest loading positive) so a refit doesn't mirror the cloud.
  5. Read only the sampled rows' embeddings, not every chunk in scope.
- **Check:** time the endpoint before and after on the same copy, and check that the layout doesn't move when a
  file is added.

### P2. The cloud redraws about 15,000 glowing sprites every frame, forever
`app/src/components/EmbeddingCloud.tsx`
- **Measured:** at 3,000 chunks it draws 15,380 sprites per frame: 3,000 nodes, 12,000 dust specks (at least 4 per
  node) and 380 stars. Each is a separate Canvas 2D `drawImage` with additive blending, on a canvas up to 2× the
  window's pixels.
- **Why it hurts:**
  - The animation loop never stops while the cloud is visible: the slow drift, twinkle and "breathing" redraw
    everything even when nobody touches it.
  - The home page shows it as the background the whole time.
  - So the GPU and CPU keep working, which means fan noise, battery drain and stutter elsewhere.
  - The per-frame depth sort is only 1.3 ms; the cost is the drawing.
- **Fix:**
  1. Draw on demand: keep the loop running only while dragging, zooming, gliding to a focus, or during the intro.
     Otherwise stop.
  2. Make the idle drift and twinkle optional (off with reduced motion, which already exists). When on, run them at
     about 20 fps instead of 60.
  3. Give the dust a total budget (for example 2,500 specks for the whole cloud, spread over the nodes) instead of
     at least 4 per node.
  4. Skip the depth sort on dark themes: additive blending gives the same image in any order.
  5. Pause when the window loses focus, as well as when the cloud is hidden.
- **Check:** use Chrome's performance panel (Electron DevTools) on the home page. CPU use with the cloud idle should
  be about zero, and frame time while orbiting should stay under 8 ms.

### P3. Streaming a chat reply re-renders and re-parses everything on every token
`app/src/chatStreams.ts`, `app/src/components/Markdown.tsx`
- **What happens:**
  - Each streamed token changes the store. The chat, the whole chat list and the mini sidebar all re-render (their
    `useChatStreams` subscriptions wake on any change).
  - The chat re-parses the whole reply so far: `marked`, then KaTeX for every formula, then DOMPurify.
  - That's quadratic in reply length. At the 51 tokens/s measured with the local model, a long reply re-parses the
    whole text about 50 times a second.
  - This is a regression from today's stream store, made worse by the existing full re-parse.
- **Fix:**
  1. Batch deltas in `chatStreams.apply` and emit once per animation frame (or every 80 ms).
  2. Use narrow subscriptions: `useLiveReply(chatId)` for the chat, and `useChatBadges()` that only changes when the
     live/unread sets change, for the chat list and mini sidebar.
  3. While streaming, render the reply in blocks: parse finished paragraphs once and keep them, and re-parse only
     the last, unfinished one.
- **Check:** use React DevTools' "highlight updates" while a 2,000-token reply streams. Only the live bubble should
  update.

## Has to: structure

### S1. Folder membership and order are kept as one JSON blob that's overwritten on every save
`ResourcePanel.saveFolders`, backend `PUT /subjects/{id}/folders` (`ui_state`)
- **Problem:** every folder change writes the subject's whole folder map. Undo for a folder reorder (added today)
  replays the map as it was at reorder time, so it silently reverts any files moved into or out of folders since.
  Files themselves are now ordered by `documents.position`, so there are two ordering systems for one list.
- **Fix:**
  - Add real tables: `folders(id, topic_id, name, position)` and `documents.folder_id`.
  - Make per-row endpoints: create, rename and delete a folder, move a file to a folder, and order the folders.
  - Migrate the existing blobs once (a numbered migration that reads `ui_state`).
  - Undo then works per change, like everything else.

### S2. The model-server quirks are still hard-coded (`APP_ANALYSIS` 3.1, High, open)
These are written into `llm.py` and `vision.py` as fixed rules:
- `reasoning_effort` only accepts `low | medium | xhigh`
- thinking is switched with `enable_thinking`
- `json_schema` is rejected
- the `<think>` handling

The next ninfer or Qwen release can break chat, vision and generation at once.

**Fix:** move them into a "server profile" (settings), and make Settings → Test connections probe each feature
(streaming usage, tools, reasoning levels, JSON) and record what works. Today's `stream_options.include_usage` is
one more such assumption (it works on ninfer today).

### S3. The OpenRouter defaults are free models by fixed ID (`APP_ANALYSIS` 3.2, High, open)
Free model IDs disappear without notice. **Fix:** fetch `/models`, let the student pick, and fail with a clear
message when the saved one is gone.

### S4. No automated front-end tests and no CI (`APP_ANALYSIS` 5.2 and 5.3, open, now more urgent)
- **Why it's more urgent now:** the front end now holds real logic (undo stack, stream store, reorder, palette
  scoring, highlight colours, find providers). Today's slash-command bug was only caught by hand.
- **Fix:**
  - Unit tests with Vitest for the pure modules: `undo.ts`, `chatStreams.ts`, `reorder.moved`, the palette's
    `score`, `textRange.findAll`/`rangeAt`, `highlights.markHighlight` and `slashCommands.matchCommands`.
  - A Playwright smoke run against a throwaway backend: open a subject, send a chat with a fake LLM, delete and
    undo a chat, reorder a to-do.
  - One script (or GitHub Actions on Windows) running `tsc`, `vite build`, `pytest` and the above.

---

## Should: performance

| # | Where | Problem (measured) | Direction |
|---|---|---|---|
| P4 | `layouts.tsx` PdfView find provider | The first Ctrl+F in a big PDF reads every page's text with pdf.js: **3.8 s** for the 917-page textbook (168k text items). The bar shows "…" until it's done. | Count and locate pages from the text the backend already extracted (`units`), and use pdf.js only for the page being shown. Or extract in a worker and show the count as it grows. |
| P5 | `FindBar.tsx`, `textRange.findAll` | `findAll` calls `rangeAt` once per match, and each call walks every text node from the start (matches × nodes). It runs again on **every** DOM change in the scope: each PDF page drawing, and each streamed token in the chat. | Use one walk that maps all match offsets to ranges, and debounce the re-search (about 150 ms, or once per animation frame). |
| P6 | `search._vectors` | 4,096-dimensional vectors: the library is 185 MB as float32, and per-scope combined copies can take the cache to its 512 MB cap. | Store the cache as float16 (halves it; cosine ranking is unaffected in practice), or keep one matrix and index rows per scope instead of copying. |
| P7 | `chunks` table | 214 MB of the 279 MB database is embedding BLOBs (16 KB each). Backups, VACUUM and study-pack exports copy all of it. | Later, if the library keeps growing: move vectors to an `.npy` per document (or sqlite-vec), and keep the database for text. Not urgent at today's size. |
| P8 | Home page start-up | The first screen waits for the cloud's projection (P1) and the subject list. | Covered by P1's saved projection. Also show the home widgets before the cloud has loaded (they already don't depend on it). |

Checked and fine: building the chat prompt (5–12 ms), the context meter's endpoint (6 ms), the change stream's
watcher, and reading every page size of a 917-page PDF (39 ms).

## Should: structure

| # | Where | Problem | Direction |
|---|---|---|---|
| S5 | `ChatView.tsx` (876 lines, 29 `useState`) | The composer, slash commands, message views, tool forms and cards all live in one file. | Split into `chat/Composer.tsx`, `chat/commands.ts` (`runCommand`), `chat/MessageView.tsx`, `chat/ToolForm.tsx` and `chat/cards.tsx`. Move only; no behaviour change. |
| S6 | `ResourcePanel.tsx` (737 lines) | It holds the panel, topic rows, topic files, my notes, to-dos and the file search. | One file each, as `views/resources/*`. |
| S7 | `SubjectView.tsx` (557 lines, 30 `useState`) | The workspace view (document, page, split, chat mode, chat geometry) is spread over many states. `restoreView` and the undo snapshot have to keep up with all of them. | One `useReducer` for the view state, so snapshot and restore are a single value. Chat geometry goes into a `useChatDock` hook. |
| S8 | `chat_api.py` (851 lines, grown again) | Chat CRUD, stats, context, streaming replies, tool cards and artifacts share one module. | `chats.py` (list/create/delete/restore/stats/context) and `chat_reply.py` (the streaming turn), keeping `chat_prompt.py` and `chat_files.py`. |
| S9 | Deletes | Chats are soft-deleted and undoable; files, generated content, notes and subjects are hard-deleted (they ask first). | Soft delete for generated content and notes the same way (cheap). Files need their units, chunks and vectors kept until purge, so do them last, if ever. |
| S10 | `SourceView.tsx` keyboard handler | It assumes the event target is an element (`t.closest`). It threw in testing when a key event came from `window`. | Guard with `instanceof Element`. Tiny. |
| S11 | CSS (`APP_ANALYSIS` 4.2, regrouping open) | Today's features were added to `5-features.css` and override earlier layers, which makes the cascade harder to follow. | Regroup by component (chat, sidebars, notes, menus, palette), with tokens staying in `1-base`. Compare computed styles before and after, as in the 4.2 cleanup. |
| S12 | Dependencies (`APP_ANALYSIS` 3.5–3.7) | Electron 33 is out of support. pdfjs-dist 4 → 5 changes the text layer used by find and annotations. Starlette's TestClient warns about httpx. | Upgrade Electron first (security), then pdf.js behind the find and annotation tests from S4. |
| S13 | Office XML parsing (`APP_ANALYSIS` 3.3) | No golden tests over real files. | 3–4 sample files with expected unit counts, equation counts and key strings. |

---

## Suggested order

1. **P3** (stream batching and narrow subscriptions): small, and it fixes a regression from today.
2. **P1 and P2** (the cloud): about a day together. The biggest felt improvement: the machine stops working hard
   whenever the cloud is visible or files are being ingested.
3. **S4** (tests and CI) before the bigger refactors, so they're safe.
4. **S1** (folders as tables), then **S5–S8** (file splits; move-only commits).
5. **S2 and S3** (model profiles), then the "should" performance items **P4–P6**.
6. **S9–S13** as time allows.

---

## Status (2026-11-07)

Everything above is done except **P7**, which the plan itself put off ("later, if the library keeps growing"). Each item
was checked as written below; `npm run check` (in `app/`) runs types, build, 28 unit tests, 122 backend tests, 6
Playwright tests and the Electron smoke run, all passing.

| # | Done | Checked |
|---|---|---|
| P1 | `projection.py`: randomized top-3 PCA on ≤1,500 rows, axes and positions stored (`cloud_axes`, `cloud_points`, migration 7), stable hashed sample, signs fixed, refit past 25% or Re-arrange | Home cloud 6.3 s → 0.81 s first fit, 0.25 s after a restart; layout identical across runs and when chunks are added (tests) |
| P2 | Draw on demand, idle drift/twinkle optional (Settings toggle), paused when the window is in the background, dust ≤ 2,500, no depth sort on dark themes. The idle drift first ran on a 20 fps timer, which looked jittery; it now follows requestAnimationFrame, capped at a Settings frame rate (see Follow-ups) | Idle on the real copy: ~923k sprites/s before → 54k/s with drift on, 0 with it off; orbiting ~140 fps |
| P3 | Two store channels (badges vs text, text batched every 60 ms), `LiveBubble` the only re-render, `StreamingMarkdown` parses finished blocks once | Unit test: no badge re-render per token, one bubble render per batch; smoke run streams a reply |
| S4 | Vitest (5 files), Playwright smoke run with a fake model server, Electron smoke run, `npm run check`, `.github/workflows/check.yml` | They found 3 real bugs: an edit straight after an undo wasn't recorded, a reorder's undo could undo the step before it, and an undo could overtake the save it undid |
| S1 | `folders` table + `documents.folder_id` (migration 8 converts the blobs), per-change endpoints, trigger on topic change | Migration on the real copy: 1 folder, 18 files, identical; backend test of every operation |
| S5–S8 | `views/chat/*`, `views/resources/*`, `views/subject/viewState.ts` + `useChatDock.ts`, `chats.py` / `chat_reply.py` / `chat_tools.py` | Move-only; types, tests and smoke runs unchanged; reducer unit tests |
| S2 | `server_profile` setting, `llm.probe_server` from Test connections, one `llm.strip_think` | Probe against ninfer in 1.1 s found exactly the old hard-coded behaviour |
| S3 | `/settings/openrouter-models`, a model list in Settings, a plain message when a model is retired | 460 models listed live (16 free); the default is still offered |
| P4 | Find warms the PDF's text when the bar opens and the count grows as pages are searched | Parallel page reads didn't help (one pdf.js worker), so the full pass still takes ~4 s on 917 pages, but matches show from the first pages |
| P5 | `rangesAt` (one walk for all matches), mutations re-searched at most every 150 ms | Unit tests against `rangeAt` |
| P6 | Per-document matrices only, scored document by document | 5.1 ms vs 7.1 ms per search on 11k × 4,096; the duplicated scope copies are gone. float16 rejected: 15-30× slower |
| P8 | Covered by P1 | Subject list 6 ms, stored cloud 0.25 s |
| S9 | Soft delete for generated content and notes (migration 9), Undo toast and Ctrl+Z, purge after a week | Backend test; files are still deleted for good (asks first), as planned |
| S10 | `instanceof Element` guard | — |
| S11 | `5-features.css` regrouped by part of the app | `tests/css/capture.mjs`: no computed-style differences on 7 screens (~6,000 elements) |
| S12 | Electron 33 → 45.2.3, pdf.js 4 → 6.4.299 (text-layer CSS updated), `httpx2` for Starlette's TestClient | Electron smoke run (offline lock, spelling, print to PDF, dialogs); `tests/pdf/check.mjs` on a real textbook (text layer, selection, find 1,896 matches) |
| S13 | `tests/fixtures/golden.{docx,pptx}` + `tests/golden/samples.json` (hashes only) | 3 golden tests |

Not done: **P7** (vectors out of the database). At 279 MB it isn't worth the risk yet; revisit past ~1 GB.
Not verified: packaging (`npm run dist`) with Electron 45 (electron-builder 25 is unchanged).

## Follow-ups (2026-11-07, asked for after the above)

| # | Done | Checked |
|---|---|---|
| F1 | Knowledge cloud frame rate in Settings → Appearance (30, 60 default, 120, or the display's; `theme.cloudFps`). Frames follow requestAnimationFrame and skip ahead to the cap; steps are capped at 100 ms after a pause. Dust no longer drops to nothing on libraries past 3,000 chunks (`dustPerNode`) | Playwright: ~30 fps at 30, clearly more at 60; unit test for `dustPerNode` |
| F2 | The revision to-do list folds from its heading (`todosFolded`), like the chat list and My notes | Playwright: folds, and stays folded after a reload |
| F3 | Separate side-by-side and full-screen buttons in the chat header (replacing the layout menu); leaving full screen returns to the previous layout | Playwright: float → side by side → full screen → back to side by side → float |
| F4 | Tables in notes (`components/noteTable.ts`): size picker, header row, Tab between cells (adds a row at the end), right-click → Table for rows, columns and delete; every change goes through `insertHTML` so the editor's undo covers it | 3 unit tests; Playwright inserts, types, adds a column, deletes a row and checks the saved HTML |
| F5 | The find bar can be dragged by its grip (double-click resets it) and closes when the content it searches leaves the page | Playwright: drags 200 px, and closes when another note opens |
