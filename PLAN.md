# AI Study App: Plan

Status: draft v2 (2026-10-31). Core functionality comes first. UI polish and animations come later.

**Guiding principle: fully offline and private.** No telemetry, no cloud calls, no external fonts or CDNs. The only network traffic is to model endpoints on localhost that the user configures.

### Decisions so far
| Area | Decision |
|---|---|
| Platform | Windows only, English, single user |
| GPU / server | RTX 5090, ninfer, Qwen 3.8 27B NVFP4 |
| Server mode | **One mode only: 100k context, vision enabled, concurrency 1.** No mode switching. |
| Embeddings | **Qwen3-Embedding-4B** in LM Studio on CPU/RAM (`http://127.0.0.1:8989/v1`) |
| Vision use | PowerPoint slides with 2+ images (configurable) are sent to Qwen as images; "Skip vision" option |
| Rendering | Native Python (PyMuPDF, python-pptx, Pillow). LibreOffice only as an optional fallback |
| Exam answers | Typed text only (no drawings or handwritten maths for now) |
| Exams | Built from an uploaded practice exam's structure; Easy / Normal / Hard; Qwen always marks |
| Reminders | In-app study/break timer, breaks up to 2h, then sound + Windows notification |
| Backend | Python sidecar, compiled into the standalone installer |

---

## 1. The architecture question: embeddings + Qwen, or Qwen only?

**Recommendation: a hybrid. Use a small local embedding model for retrieval, Qwen 27B for understanding and generation, and choose per request whether to put the whole topic in context or retrieve pieces of it.**

### Why not Qwen only (summarise at ingest, generate from the summaries)?
- **Summaries lose information.** Flashcards, quizzes and exams depend on specific facts: values, definitions, edge cases, worked examples. A summary keeps the gist and drops exactly those details. Questions written from summaries come out shallow and sometimes slightly wrong.
- **You can't cite sources.** With no chunk-level index, you can't show "this answer came from slide 14 of Kinematics.pptx". Citations are the main way to trust a local model's output.
- **Chat doesn't scale.** Every chat turn would either re-read everything (slow) or answer from summaries (vague).
- **It's slow.** Getting a 27B model to read every page at ingest takes minutes per document. Embedding the same document takes seconds.

### Why not embeddings + top-k retrieval for everything?
- Retrieval suits **targeted** requests: chat, and "explain X".
- It's poor at **coverage** requests: full notes, or an exam spanning the whole topic. Top-k returns the most similar chunks, not a representative spread, so whole sections get skipped silently.

### The hybrid
| Request | Strategy |
|---|---|
| Chat / ask a question | Hybrid retrieval (BM25 + vectors, optionally reranked) → Qwen answers with citations |
| Flashcards, short quiz | Coverage-driven: go section by section through the topic outline, not top-k |
| Exam | Coverage plan (blueprint of sections × difficulty × question type) → generate per section → assemble |
| Full notes compilation | Map-reduce over the outline: notes per section → merge → final pass for consistency |
| Topic fits in context | **Full-context mode**: skip retrieval and give Qwen everything (best quality) |

A topic's material is usually a handful of PPTs and docs, roughly 20–80k tokens, so **many topics will fit whole into the 120k text context**. The app measures the token count for each topic and picks full-context mode or retrieval/map-reduce automatically, with a manual override.

### Qwen still helps at ingest, in a cheaper role
Embeddings don't replace Qwen at ingest. Qwen runs in a light, one-off role:
1. **Document map:** for each document, an outline of sections with a 1–3 sentence summary and key terms each. This drives coverage-based generation and the topic overview.
2. **Visual transcription:** vision mode turns diagrams, slide images, scanned pages and equations into text or LaTeX once, at ingest. After that, everything runs in the 120k text mode.

### Textbooks: embeddings make them usable
Textbooks are the reason to have embeddings. A 600-page textbook is about 300–500k tokens: far too large for any context window, but trivial to embed (a few minutes, once). Proposal:
- **Subject-level reference library.** You attach textbooks to the *subject* (Physics), not the topic.
- Topic-specific uploads (Motion PPTs) stay the **primary source**.
- When generating, the app also retrieves the most relevant textbook passages for the topic and passes them to Qwen as **supporting/authoritative reference**: for checking facts, filling in definitions, and adding depth.
- The textbook's TOC is parsed so chapters can be mapped to topics (for example Physics > Motion ↔ Ch. 2–3), which narrows retrieval to the right chapters.
- Citations then point to "Textbook p. 47" as well as the slide.

---

## 2. Model setup

| Role | Model | Where | Notes |
|---|---|---|---|
| Generation / chat / marking / vision | Qwen 3.8 27B NVFP4 | ninfer on the 5090 | 100k context, vision on, **1 request at a time** |
| Embeddings | **Qwen3-Embedding-4B** | LM Studio, CPU/RAM | Higher quality than 0.6B, slower on CPU; throughput measured in Phase 0 |
| Reranker (optional, phase 3+) | Qwen3-Reranker-0.6B | CPU | Better chat retrieval; skip if too slow on CPU |

Each chunk records which embedding model produced it, so switching models later triggers a re-embed. If 4B is too slow on CPU for textbooks, 0.6B is the drop-in fallback.

- All model endpoints are **OpenAI-compatible URLs, set in Settings** (ninfer for chat/vision, LM Studio for `/v1/embeddings`, default `http://localhost:1234/v1`). Nothing is hardcoded. A "Test connection" button reports the model name, context size and whether vision is available.
- **Concurrency 1:** the app sends Qwen **exactly one request at a time** through a single queue, so the server never rejects a request. Priority order: interactive (chat, marking a single answer) > generation jobs > vision ingest. A long background job is split into small steps (one section, one slide), so a chat message can slip in between steps instead of waiting for the whole job. The concurrency limit is a setting, so it can go up to 2 later.
- **No mode switching:** the server always has vision on. Vision work still runs as a low-priority background lane.
- **Per-request context budget:** 100k total → ~10k for the system prompt and instructions, ~8–12k for thinking, ~8–12k for output, which leaves **~65k tokens of source material per call** (images count too, at roughly 1–2k tokens each). This threshold decides between full-context mode and retrieval/map-reduce.
- **Structured output:** flashcards, quizzes and exams are generated with JSON-schema-constrained decoding (vLLM `guided_json` / llama.cpp `json_schema`). Results are validated with a schema, and failures are repaired or retried.
- **Thinking tokens:** Qwen's reasoning counts against the context budget. Budget it: thinking on for exams and notes, off or low for chat and flashcards.
- **Context budget:** keep about 25% of the window free for the prompt, thinking and output. In text mode, roughly 85k tokens of material per call.

---

## 3. Tech stack

- **Electron + React + TypeScript + Vite** for the shell and UI. Tailwind plus Framer Motion later for the sleek, animated pass.
- **Python sidecar (FastAPI)** started by Electron. Document parsing is much better in Python (PyMuPDF, docling, python-pptx). Electron talks to it over localhost HTTP/WebSocket.
- **SQLite** as the single store:
  - relational data (subjects, topics, docs, artifacts, reviews)
  - **FTS5** for BM25 keyword search
  - **sqlite-vec** for vectors (LanceDB is the fallback if it gets slow)
- **Files** are copied into the app data directory, deduplicated by content hash.
- **Job queue** (persisted in SQLite) for ingest and generation: progress, cancel, resume after a crash or restart, a single Qwen lane (concurrency 1, priority-ordered), plus a separate CPU lane for embedding.
- **Offline enforcement:** Electron blocks every request that isn't to localhost or a configured endpoint. A strict CSP. Fonts, icons and KaTeX are bundled. No auto-updater phoning home, no crash reporting. All data lives in `%APPDATA%\<AppName>`, with a "Export/backup library" option.

---

## 4. Ingestion pipeline

```
upload → hash/dedupe → parse → normalise → visual pass → chunk → embed → document map → ready
```

### Parsing per format
| Format | Tool | Extracted |
|---|---|---|
| PDF (digital) | PyMuPDF / docling | Text per page, headings, tables; page images where diagrams are present |
| PDF (scanned) | Page render → Qwen vision (or OCR fallback) | Transcribed text |
| PPTX | python-pptx (+ Pillow) | Slide text, **speaker notes**, tables, image count/area per slide, embedded image files for vision |
| DOCX | docling / python-docx | Headings, paragraphs, tables, embedded images |
| Images | Qwen vision | Description + transcription (diagrams, handwriting, equations) |
| TXT / MD / CSV / HTML / RTF | Direct / light conversion | Text |
| Legacy .ppt / .doc | LibreOffice convert → as above (only if installed; otherwise ask the user to re-save as .pptx/.docx) | |

- **Normalised form:** every document becomes an ordered list of "units" (page / slide / section) carrying text, images, and source location. Everything downstream works on that form, so it doesn't depend on the original format.
- **Visual pass.** It only runs on units that meet these rules (thresholds are adjustable in Settings):
  - **PowerPoint:** a slide with **2 or more images**, *or* one image covering more than 40% of the slide, *or* almost no text (under ~15 words) next to an image. Those slides go to Qwen.
  - **How slides are "screenshotted" without PowerPoint or LibreOffice:** no pure-Python library renders PPTX at full fidelity, so the app uses python-pptx and Pillow to build a **slide composite**: each embedded image placed at its real position and size on a canvas the size of the slide, with the slide's text drawn in its text boxes. The original image files and the extracted text are sent along too. Arrows and connectors drawn as PowerPoint shapes are lost, but diagrams that are pictures (the usual case) survive intact. **LibreOffice is an optional add-on**: if it's installed, the app uses it for full-fidelity renders instead.
  - EMF/WMF vector images (common in older decks) are converted with Pillow on Windows, falling back to LibreOffice if that's installed.
  - **PDF / DOCX:** pages with embedded figures above a size threshold, or pages with no extractable text (scans).
  - **Standalone images:** always, unless vision is skipped.
  - Small images (logos, icons, bullets, repeated template graphics) are ignored. Images that appear on most slides are treated as template decoration.
  - Qwen gets the screenshot **plus the slide's extracted text**, and returns either a transcription/explanation of the visual content (diagrams, graphs, circuits, tables, equations → LaTeX) or `IRRELEVANT` for decorative images, which are then dropped.
  - The output is merged into the unit's text, tagged `[figure: …]`.
- **Skip vision:** a toggle on each upload batch (default comes from Settings), plus "Run vision later" per document. Skipped units are flagged, so you can run vision on them later without re-ingesting.
- **Ingest order:** text parsing → chunk → embed happens straight away, so the topic is usable at once. Vision runs as a later batch, and its results are re-chunked and re-embedded for the affected slides only.
- **Maths:** equations are transcribed to LaTeX and rendered in the UI with KaTeX. This matters for physics and mechatronics.
- **Chunking:** structure-aware. Split on headings, slides and pages; target ~400–800 tokens with small overlap. A chunk never crosses a document boundary. Each chunk stores `doc_id, unit_range, heading_path` for citations.
- **Document map:** described in §1.
- **Re-ingest:** the parser/embedder version is stored per document, so changing the embedding model re-embeds automatically.

---

## 5. Retrieval

1. Query → (optional) Qwen rewrites the query using chat history.
2. BM25 (FTS5) + vector search in parallel → merged with reciprocal rank fusion.
3. Scope filter: topic only / topic + subject textbooks / whole subject.
4. Optional rerank of the top ~40 → keep top ~8–15.
5. Expand neighbours (adjacent chunks/slides) for continuity.
6. The prompt includes chunks labelled `[S1] [S2]…`. The model must cite them, and the UI links each citation to the source page or slide.

---

## 6. Content types

### Core (MVP)
1. **Chat**: topic-scoped, cited, streaming, persistent threads. Buttons: "Explain simpler", "Give an example", "Quiz me on this".
2. **Flashcards**: basic, cloze, and image-occlusion later. Spaced repetition with **FSRS**. Each card links to its source. Cards can be edited, deleted and regenerated.
3. **Short quiz**: 5–15 MCQ / true-false / short answer. Instant feedback with an explanation and citation for each question.
4. **Exam (built from a practice exam)**: see §6a. Timed mode, Qwen always marks, per-question feedback, score breakdown by part.
5. **Full notes compilation**: structured notes following the topic outline, with definitions, key formulas, worked examples, diagrams (transcribed), and a summary at the end. Exports to PDF/Markdown.

6. **Study timer & reminders**: see §6b.

### 6a. Exam generation from a practice exam

**Flow when you choose "Create exam":**
1. **Upload a practice exam** (PDF / DOCX / image / PPTX), for example one from a tutor or found online. The app asks for an exam from the *same subject* and explains why. It is **not embedded** and never enters the topic's search index. It's stored separately as an exam template source.
2. **Structure analysis.** The whole practice exam goes to Qwen. Scanned exams or exams with diagrams use vision mode, or they're queued for it. Qwen extracts an **Exam Blueprint** (JSON):
   - parts/sections (A, B, C…) with titles and instructions
   - for each part: question type (MCQ, true/false, short response, long response/essay, calculation, case study, diagram labelling, fill in the blank…), number of questions, marks per question, sub-question structure (e.g. case study → stimulus + 4 sub-questions)
   - total marks, time allowed, reading time
   - **difficulty profile:** cognitive level per part (recall / apply / analyse / evaluate), MCQ distractor quality, typical answer length, how much calculation
   - style notes: command words ("explain", "evaluate", "calculate"), formatting, whether a formula sheet is provided
3. **Subject check.** Qwen compares the exam's subject with the topic/subject material. If they don't match (a physics exam for a computing topic), you get a warning: "This looks like a Physics exam. Use structure only and ignore its content?", and can continue or upload another.
4. **Review screen.** The app shows the extracted structure ("Part A: 10 × MCQ, 1 mark each…"), which you can edit before generating. This catches analysis mistakes cheaply.
5. **Choose difficulty:** Easy / Normal / Hard.
   - **Easy:** same structure and marks, simpler questions. More recall, fewer steps in calculations, more obvious MCQ distractors, more scaffolding in case studies.
   - **Normal:** matches the practice exam's difficulty profile.
   - **Hard:** same structure, harder questions. More apply/analyse/evaluate, multi-step calculations, closer distractors, combinations of concepts from several sections.
6. **Choose scope:** which topics/documents in the subject to draw from, and whether to include textbook reference.
7. **Generate.** Questions are spread across the source material's sections (coverage, not top-k). Each part is generated separately, one request at a time. Every question is **completely new**: an explicit check rejects questions that copy or closely paraphrase the practice exam.
8. **Answer key + marking guide** are generated alongside: the correct MCQ option, model answers, and a marking rubric per written question (mark allocation per point), all citing sources.
9. **Saved as reusable:** the blueprint is saved on the subject, so you can generate more exams from the same structure later without re-uploading.

**Taking and marking:**
- Exam UI follows the blueprint (parts, numbering, marks shown), with an optional timer and auto-save.
- **Qwen marks every exam.** MCQ and true/false answers are also checked against the stored key for reliability. Short and long responses, calculations and case studies are marked by Qwen against the rubric. Marking returns marks per question, what you got right, what's missing, the model answer, and source citations.
- Results: total, per-part breakdown, a grade band, and weak sections fed into mastery tracking. You can ask for a re-mark with a comment ("I think my answer covered point 2").

### 6b. Study timer & reminders
- **In-app study timer:** start a study session (optionally tied to a subject/topic). Session time is logged for stats.
- **Break timer:** take a break of any length up to **2 hours** (presets 5/15/30/60/120 min plus custom). When it runs out:
  - an alert sound plays (bundled, selectable, volume control)
  - a **Windows desktop notification** appears ("Break's over — back to Physics > Motion?") with actions: *Resume*, *Snooze 10 min*
  - the notification and sound work while the window is minimised or closed to the **system tray**
- **Optional reminders:** daily study reminder at a set time, and a "flashcards due" notification from the spaced-repetition schedule.
- Settings: sound on/off, quiet hours, start with Windows (minimised to tray).
- Built with Electron's `Notification` API (with an AppUserModelID set so Windows notifications work) and a tray icon. Timers run in the main process, so they survive the UI reloading.

### Extras (post-MVP, ranked by value)
- **Cheat sheet / one-page summary**
- **Glossary** of key terms
- **Practice problems with worked solutions** (strong fit for physics and mechatronics)
- **Concept map** (Mermaid / graph view of how ideas connect)
- **Weak-area tracker:** quiz, exam and flashcard results feed a per-section mastery score, and new quizzes target weak sections
- **Gap check:** compare topic uploads against the textbook chapter and flag what the uploads don't cover
- **Anki export** (.apkg)

### Generation-request options (shared)
Scope (whole topic / selected docs / selected sections), quantity, difficulty, whether to include textbook reference, focus instructions in free text.

---

## 7. Generation pipeline (example: exam)

1. **Blueprint:** from the practice exam (§6a), confirmed by the user, plus the difficulty level.
2. **Allocate:** using the document maps, spread the blueprint's questions across the source sections, so the whole topic is covered and weighted by how much material each section has.
3. **Gather:** for each part, collect the allocated sections' chunks (full-context mode if the scope fits in ~90k tokens) plus textbook passages if enabled.
4. **Generate:** one call per part (sequential, C=1), schema-constrained, with source IDs required on every question, and a difficulty instruction plus examples of the *style* (not content) of the practice exam's questions.
5. **Verify:** a second pass checks each question and its answer key against the cited source, checks the difficulty matches, and rejects questions that are unsupported, ambiguous or too close to the practice exam. Rejected questions are regenerated.
6. **Assemble:** order, number as the blueprint says, compute totals, save as an artifact.
7. **Stream progress** to the UI: "Part B: question 3/5…".

Flashcards, quizzes and notes use the same plan → gather → generate → verify → assemble pattern with different prompts and schemas.

---

## 8. Data model (initial)

```
Subject(id, name, color, created_at)
Topic(id, subject_id, name, description, created_at)
Document(id, topic_id | subject_id, kind[topic|reference], filename, mime, hash,
         status, token_count, parser_version, created_at)
Unit(id, document_id, index, type[page|slide|section], text, image_path, needs_vision)
Chunk(id, document_id, unit_start, unit_end, heading_path, text, token_count)
ChunkVec(chunk_id, embedding)               -- sqlite-vec
ChunkFts(chunk_id, text)                    -- FTS5
DocMap(document_id, outline_json)
Artifact(id, topic_id, type[notes|flashcards|quiz|exam|...], title, params_json,
         content_json, status, model, created_at)
Flashcard(id, artifact_id, front, back, source_chunk_ids, fsrs_state_json, due_at)
Review(id, flashcard_id, rating, reviewed_at)
PracticeExam(id, subject_id, filename, hash, extracted_text, created_at)   -- never embedded
ExamBlueprint(id, subject_id, practice_exam_id, name, blueprint_json, created_at)
Exam(artifact) -> params_json holds blueprint_id + difficulty[easy|normal|hard] + scope
Attempt(id, artifact_id, answers_json, score, marking_json, started_at, finished_at)
StudySession(id, subject_id?, topic_id?, started_at, ended_at, kind[study|break])
Reminder(id, kind[break_end|daily|cards_due], fire_at, payload_json, status)
ChatThread(id, topic_id, title) / ChatMessage(id, thread_id, role, content, citations_json)
Job(id, type, payload_json, status, progress, error, created_at, updated_at)
Mastery(topic_id, section_key, score, updated_at)
Settings(key, value)
```

---

## 9. Phased roadmap

**Phase 0: validation spike (do this first, ~a few days)**
- Confirm the ninfer API is OpenAI-compatible (chat, streaming, image input, JSON-schema output), measure tokens/sec and prompt-processing speed at 90k context, test 2 concurrent requests, and check how mode switching works.
- Measure Qwen3-Embedding-0.6B throughput in LM Studio on CPU (chunks/sec).
- Test structure extraction on 2–3 real practice exams.
- Parse 3 real files from your courses (one PPT, one PDF, one DOCX) and inspect the output.
- Generate 20 flashcards and 1 short quiz end to end with a throwaway script, and judge the quality.
- *Outcome: confirm the hybrid approach, pick the embedding model, and set realistic expectations for job duration.*

**Phase 1: skeleton**
- Electron + React + Python sidecar wiring, SQLite schema, settings page (model URLs, test-connection button).
- Subject/topic CRUD, file upload with drag and drop, document list with status.

**Phase 2: ingestion**
- Parsers for all formats, normalised units, visual pass, chunking, embedding, document maps.
- Job queue with progress UI, cancel and retry. Re-ingest/delete documents.
- Subject reference library (textbooks) with TOC → topic mapping.

**Phase 3: retrieval + chat**
- Hybrid search, citations, source viewer (open a PDF page or slide image at the cited spot).
- Streaming chat with persistent threads.

**Phase 4: generators**
- Flashcards → quiz → notes → exam, in that order (rising complexity).
- Shared generation framework: plan / gather / generate / verify / assemble, schema validation, retries.
- Full-context vs retrieval auto-selection.

- Exam: practice-exam upload → blueprint extraction → review screen → difficulty → generation.

**Phase 5: study loop**
- FSRS review sessions, quiz/exam taking UI, Qwen marking, attempt history, mastery tracking, weak-area targeting.
- Study/break timer, tray icon, sound + Windows notifications, daily/cards-due reminders.
- Exports (PDF / Markdown / Anki).

**Phase 6: polish**
- Design system, sleek UI, Framer Motion animations (card flips, page transitions, progress, streaming text), dark/light themes, keyboard shortcuts.

**Phase 7: packaging**
- electron-builder NSIS installer (Windows), Python sidecar compiled with PyInstaller (or Nuitka) and shipped inside the app, health checks of model servers, local logs and diagnostics.
- LibreOffice is **not bundled**. If the user has it installed, the app detects it and uses it for full-fidelity slide renders and legacy .ppt/.doc conversion. Otherwise native Python handles everything.

---

## 10. Quality and evaluation
- Build a small **gold set** from one topic: 20 questions with known answers and source locations.
- Measure **retrieval hit rate** (is the right chunk in the top 10?) whenever chunking or embedding changes.
- Spot-check generated items for **faithfulness** (supported by the source?) and **coverage** (were all sections hit?).
- Store prompts as versioned templates in files, not inline strings, so they can be tuned without code changes.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Slow generation (27B, long context) | Background jobs, streaming, per-section progress, full-context only when it pays off |
| Vision/text mode switching friction | Batch visual work; ingest-time only |
| Hallucinated or wrong answers | Mandatory citations, optional verify pass, textbook cross-reference |
| Poor parsing of complex PPTs/PDFs | Visual pass fallback; per-document "view extracted text" so problems are visible |
| GPU memory contention (embedder + Qwen) | Embedder on CPU, or a small embedder; one GPU job at a time |
| JSON output failures | Constrained decoding + schema validation + repair retry |
| Practice-exam structure extracted wrongly | Editable review screen before generating |
| Generated exam too close to the practice exam | Similarity check in the verify step, then regenerate |
| Inconsistent marking of written answers | Rubric generated with the exam; low temperature; marks per rubric point; re-mark option |
| Slow CPU embedding of big textbooks | Background lane, resumable, topic stays usable meanwhile |

---

## 12. Phase 0 results

Scripts are in `spike/`. Endpoints and keys live in `.env` (gitignored, never hardcoded). Test material: `spike/samples/Physics` (1 DOCX, 2 PDFs, 1 PPTX, of which one PDF is a practice question book).

### Models
| Test | Result |
|---|---|
| Embeddings: LM Studio, `qwen3-embedding-4b`, CPU + DDR5 | 2560-dim. Real chunks: **~11 chunks/s (~5.4k tok/s)**. A 600-page textbook takes ~1.5–2 min. |
| Retrieval smoke test (real material) | Correct section at #1 for 3/4 queries (e.g. "conservation of energy in a loop" → the right textbook pages). Weak for broad slide groups (see fixes). |
| ninfer `/v1/models` | `qwen3.8-27b`, `max_model_len` 100000 |
| Thinking toggle `chat_template_kwargs.enable_thinking` | Works. Off: 0.2s for a one-line answer. |
| Decode speed | **150–190 tok/s** |
| Prefill speed | ~1,850 tok/s at 30k, ~1,620 tok/s at 60k (**16s / 37s** to first token) |
| **Prefix caching** | Same 30k prefix sent again: **0.1s** to first token |
| Vision (image_url, base64 PNG) | Works. A 1600px slide costs ~1.4k prompt tokens and took ~3s with a good description. |
| `response_format: json_schema` | **Not supported** (ninfer returns 400: it can't guarantee constrained output) |
| Prompt-based JSON + pydantic validation + repair | **10/10 valid on the first attempt** (thinking on and off) |

### Parsing (native Python only)
| File | Units | Text tokens | Vision candidates | Notes |
|---|---|---|---|---|
| Wave Behaviours…pptx | 64 slides | ~4.4k | 17 | 24 equations → LaTeX; 14 title-only/divider slides |
| ElectricalCircuits.pdf (textbook chapter) | 50 pages | ~21k | 32 | "PAGE PROOFS" full-page watermark correctly ignored; circuit diagrams are vector drawings |
| Chapter 2 Notes.docx | 1 section | ~1.8k | 1 | 24 equations → LaTeX; 24 duplicate equations in `mc:Fallback` correctly skipped; **no heading styles at all** |
| Question Book.pdf (practice exam) | 9 pages | ~1.8k | 2 | Kept out of the topic material |
| **Whole topic** | | **~29k** | | Fits in full-context mode (~65k budget) with room to spare |

### Fixes found and applied in the spike
- Equations (OMML) were silently dropped by standard text extraction → a new OMML→LaTeX converter (`spike/omml.py`).
- PPTX picture placeholders weren't counted as images, and text inside AlternateContent was missed → slides are now read by walking the XML.
- PDF full-page background/watermark images were treated as figures → ignored when the page has real text. Vector drawings are now detected.

### Design changes from these results
1. **Prompt layout built for the prefix cache.** Every Qwen call for a topic starts with the same prefix: `[system prompt][topic material, fixed order]`. Only the task instruction at the end changes. The first call pays the prefill (~15–35s), and every later call on that topic (chat turns, each exam part, verify passes, marking) starts almost instantly. This makes **full-context mode the default** for any topic under ~65k tokens, and chat uses full context too instead of retrieval when the topic fits. Textbook passages retrieved for a request go *after* the cached prefix.
2. **Structured output** = schema in the prompt + pydantic validation + repair retry (`spike/llm_json.py`). No server-side constrained decoding.
3. **Vision is cheap** (~3s per image), so the PDF heuristic can be generous. For textbook chapters (diagram-heavy), offer "Vision on every page". Even 600 pages is ~30 min in the background.
4. **Chunking:** cap slide chunks at ~5 slides (13-slide merges were too broad to retrieve well), and locate DOCX chunks by paragraph range when there are no headings.
5. **DOCX without heading styles** (common in student/teacher notes): detect headings from font size or bold, otherwise rely on Qwen's document map for structure.

### Still to test
- Practice-exam structure extraction on the Question Book (§6a)
- First flashcard / quiz generation from the full topic in full-context mode, judged for quality
- Vision pass on real slides and PDF pages (quality of circuit and graph descriptions)
- Qwen marking a written answer against a rubric
- Text in SmartArt/charts on the 14 near-empty slides

---

## 13. Ingest policy (decided 2026-10-31)

**Quality and accuracy over processing speed and compute cost.** Ingest is the most critical phase.

- **Deduplication is deterministic and exact, done in code, never by a model.**
  - File level: identical file bytes (SHA-256) in the same scope are not ingested twice.
  - Unit level (slide/page/section): a unit whose exact text (and exact image bytes) matches an earlier unit in the same scope is marked `duplicate_of` and isn't chunked, embedded or sent to vision. It stays visible in the document viewer.
  - Repeated PDF headers/footers: a line that appears *character-for-character* on ≥50% of pages (documents with ≥4 pages) is removed. Lines that only nearly match (e.g. page numbers) are kept.
- **What gets embedded is only the real extracted text** (slide text, speaker notes, tables, page text, equations as LaTeX).
- **Vision notes sit beside the text, not inside it.** Qwen's description of figures, diagrams, graphs and image text is stored on the unit and linked to its chunks. It isn't embedded. Generators (flashcards, notes, exams…) read it together with the chunk text.
- **Vision defaults:** topic material uses a *generous* automatic heuristic. **Reference textbooks: vision on every page.** Thinking is on for vision.
- **Not yet decided:** units with *no* text (image-only slides) are unreachable by search, because their only content is vision notes. Option: index vision notes in keyword search (not vectors) only for text-less units.
