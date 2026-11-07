# Fix plan: 18 UI / chat / notes issues

Written 2026-11-07 against the working tree on `master` (with the uncommitted QoL changes, incl. migration 5).
Item numbers match the original list. Shared groundwork comes first because several items depend on it.

## Order of work

| Phase | Items | Why this order |
|---|---|---|
| 0. Groundwork | chat stream store, usage capture, context-menu fix, undo stack | 15, 11, 14, 10, 13, 6, 7, 2, 18 all build on these |
| 1. Chat | 15 → 14 → 1 → 2 → 11 → 17 → 13 → 10 → 12 | 15 first: it rewrites the state 14/11 hang off |
| 2. Notes | 6 → 7 → 8 → 5 → 4 | 6 changes the menu component 7 and 5 use |
| 3. Lists & files | 3, 16, 9 | independent of the above |
| 4. App-wide | 18 | needs the reversible operations from 2 and 3 to exist |

One DB migration covers all schema changes: **`(6, [...])`** in `db.MIGRATIONS` (after the pending 5):

```sql
ALTER TABLE chats     ADD COLUMN deleted_at REAL;      -- 2, 18: soft delete
ALTER TABLE todos     ADD COLUMN position INTEGER;     -- 3
ALTER TABLE documents ADD COLUMN position INTEGER;     -- 3
ALTER TABLE artifacts ADD COLUMN position INTEGER;     -- 3
```

---

## Phase 0: groundwork

### G1. A chat stream store, outside React (`app/src/chatStreams.ts`, new)

**Why:** `ChatView` keeps one `streaming` state and one `onEvent` for the whole component
(`ChatView.tsx:40`, `:165`). `onEvent` appends every streamed message to whatever `messages` currently holds,
and the live bubble draws in whichever chat is open. That's bug 15. And since `SubjectView` is keyed by subject
(`App.tsx:56`), switching subject unmounts the chat. The fetch keeps reading, but nobody is listening anymore, so 11 can't work either.

**Change:**
- A module-level store keyed by chat id: `{ chatId, subjectId, text, reasoning, status, started, messages: Message[], done, error }`.
  `startStream(chatId, subjectId, run)` owns the `api.ask/editMessage/regenerate` call. Every event goes into
  that chat's entry, never into component state.
- `useChatStream(chatId)` (`useSyncExternalStore`) gives ChatView the entry for the chat it is showing. The
  live bubble and the "busy" state come from that, so they only show in the chat that is actually generating.
- When a stream ends: if its chat is open, ChatView reloads that chat once (`api.chat(id)`) to resync with the
  server. Otherwise the chat id is added to the **unread** set (see 11).
- Also exposes `activeStreams()` (sidebar spinners, the stop button) and `unread` (persisted through `prefs.ts`).

### G2. Usage capture (`llm.chat_stream`, `chat_api._respond`)

- Send `stream_options: {include_usage: true}` (and for OpenRouter `usage: {include: true}`, which adds `cost`).
  `chat_stream` yields `("usage", {...})` from the final chunk.
- `_respond` sums usage across tool rounds and stores it on the assistant message's `meta`:
  `usage: {prompt, completion, reasoning, cost, seconds, model, provider}`. `seconds` is wall time from request
  to last token.
- **Verify first:** whether ninfer actually sends a usage chunk when streaming. If it doesn't, use
  `usage.estimated = true` with `len(text)/3.6` counts, and mark them "≈" in the UI.

### G3. Context menus that always fit (`components/overlay.tsx`, `2-components.css`)

**Why (item 6):** `ContextMenu` clamps `y` to `innerHeight - height - 8`, but a menu taller than the space
left (the notes menu with a selection is ~14 rows) still overflows. Nothing makes it scroll, and it isn't
portalled, so a transformed or clipped ancestor can cut it off.

**Change:**
- Portal the menu to `document.body` (like `Modal`).
- `.ctx-menu { max-height: calc(100vh - 16px); overflow-y: auto; }`, with `top = max(8, …)` so the top edge
  never goes off screen.
- Once the root menu scrolls, `overflow: auto` would clip the absolutely positioned `SubMenu`. So submenus are
  also portalled and `position: fixed`, placed from their row's rect (the existing flip logic stays).
- Add a `MenuItem.swatches?: {css, label, onClick}[]` row type (a row of clickable colour dots). G3 only adds the
  type; item 7 uses it.

### G4. Undo stack (`app/src/undo.ts`, new)

Built in phase 4 (item 18). Items 2 and 3 only need to register their inverse functions with it, so their code
is written against the `undoable()` signature from the start (see 18).

---

## Phase 1: chat

### 15. Text from a running reply shows up in another chat
Fixed by G1. ChatView also stops doing `setMessages((ms) => [...ms, e.message])` from a stream. `send` /
`rerun` hand the stream to `startStream` and return. The `streaming` guard on `send` becomes per chat: another
chat can send, and its reply waits at `llm._gate()` with the status "Waiting for Apollo to finish another reply…"
(concurrency is 1).
**Test:** start a long xhigh reply, then click New chat, open an older chat, and switch subject and back. The
reply must only appear in its own chat, and in full once it finishes.

### 14. Stop button instead of send while generating
- Composer: while *this* chat's stream is live, the ↑ send button becomes ■ Stop (same spot, `send-btn stop`).
- Backend: `POST /chats/{cid}/stop` sets the cancel flag on the running `jobs` row (`type='chat' AND ref_id=cid
  AND status='running'`), the same thing the jobs list's Cancel does.
- Today `pipeline.Cancelled` throws the partial reply away (`chat_api.py:465`). Instead, save `prefix + content`
  as the assistant message with `meta.stopped = true` and show a small "Stopped" tag under it. Error text becomes
  "Stopped." (not "…from the jobs list").
- Limitation: `tracked.cancelled()` is only checked per streamed chunk, so a stop during a long prefill waits
  for the first token. Fix: `chat_stream` takes a `cancelled` callable, and a small watcher thread closes the
  httpx response when it flips.

### 1. At most one new chat
- Backend `create_chat`: if the subject already has a chat with **no messages**, return it (updating
  `topic_id`/`updated_at`) instead of inserting. This covers double clicks, StrictMode and both "+" buttons
  (`ChatView.tsx:280`, `LibraryPanel.tsx:176`).
- Frontend: if the open chat is empty, "+" just focuses the composer. The button is also disabled while a create
  request is in flight.
- Test in `tests/test_qol.py`: two creates return the same id; after a message is sent, a create returns a new id.

### 2. Delete chats from the sidebar (× at the far right)
- `ChatHistory` rows get a `×` button (`ch-del`, visible on row hover, always visible on the active row) at the
  right edge. It sits after `.ch-topic`, and the name ellipsises before it.
- One click, no confirm dialog. It **soft-deletes**: `DELETE /chats/{cid}` sets `deleted_at`, `list_chats`
  filters it out, `POST /chats/{cid}/restore` clears it. A toast "Chat deleted · Undo" shows for ~6 s, and the
  same inverse goes on the undo stack (18).
- Purge rows with `deleted_at < now - 7 days` on startup (`jobs` startup hook), so messages don't pile up.
- Deleting the open chat opens the next one (or the empty state), as now.
- If the chat being deleted is streaming: stop it first (14).

### 11. Notification dots for finished replies
- From G1: a stream that ends while its chat isn't open (or the chat is minimised, or the window isn't focused)
  adds `chatId → subjectId` to `unread` (prefs, so a restart keeps it).
- `ChatHistory`: an accent dot before the title for unread chats, and a small spinner for chats streaming right now.
- `Minibar`: a dot on a subject's icon when any of its chats is unread (or streaming: spinner ring).
- Opening the chat clears its dot. A stream that ends in an error also marks it unread (red dot).

### 17. The message box grows with the text
- `textarea` gets `field-sizing: content` (Electron 33 = Chromium 130, supported; now Electron 45), `min-height` = 2 rows, and
  `max-height: 40%` of the chat body, scrolling after that. `rows={2}` goes. Back to 2 rows after send.
- Check the floating chat at its minimum height (MIN_H) so the composer can't push the messages out.

### 13. Context limit bar
- A thin bar in `composer-bar` (right of the reasoning pill) showing used ÷ `llm.context_tokens()`. It turns
  amber past 75% and red past 90%.
- Data: `GET /chats/{cid}/context` returns `{limit, system, material, history, total, exact}`:
  - after a reply: `exact = true`, using the last turn's `usage.prompt + completion` (G2), plus
    a breakdown estimated from character counts;
  - before any reply (or for a new chat): estimated from `_system_prompt(chat)` + `_history(cid)`, `exact = false`.
  It refreshes when a stream ends, the topic changes, or a chat opens.
- Hover tooltip (the existing `data-tip` layer): "41,203 / 100,000 tokens (41%) · material 30,880 · history 8,112 ·
  instructions 2,211". It also says when retrieval mode is on: material is then retrieved excerpts, not the
  whole scope.

### 10. Slash commands
- `app/src/components/slashCommands.ts`: a registry `{ name, args?, summary, run(ctx, argText) }`. Typing `/`
  at the start of the box opens a palette above the composer (filtered as you type; ↑/↓, Tab completes, Enter
  runs, Esc closes). Commands run locally and are **never sent to Apollo**.
- Results show as **local cards** in the message list (not stored, gone on reload), styled like `msg-note`.
- First set:

  | Command | Does |
  |---|---|
  | `/stats` | This chat: replies, tokens in/out/reasoning, time spent generating, cost (OpenRouter: summed `cost`; local: "free, ran on this PC"). `/stats subject` and `/stats all` for wider totals. |
  | `/effort off\|low\|medium\|xhigh` | Same as the Reasoning pill (also saves the pref). With no argument it shows the current level. |
  | `/create flashcards\|quiz\|exam\|notes\|cheatsheet\|mindmap [focus]` | Opens that tool form (`quick()`), prefilling focus. |
  | `/topic <name>` | Sets the chat's topic (fuzzy match). |
  | `/new`, `/rename <title>`, `/title` (name with Apollo), `/delete` | Chat management. |
  | `/todo <text>` | Adds a to-do. |
  | `/context` | The numbers from 13, as a card. |
  | `/help` | Lists commands. |

- Backend: `GET /chats/{cid}/stats?scope=chat|subject|all` aggregates `meta.usage` from assistant messages
  (G2). Older messages have no usage, so the card says "n older replies not counted".
- Contract test for the new response shapes (`tests/test_api_contract.py`).

### 12. Split screen with the chat (half and half)
- Today the chat is either a floating corner window (`floating`) or the whole centre (`full`). Add a third mode,
  `split`: the centre divides into the document/cloud/note pane and the chat, 50/50 by default.
- `SubjectView`: `chatMode: 'float' | 'split' | 'full'` (pref `chatMode`). In `split`, `geo` = the docked half on
  `side`, and `.center` gets `--chat-split: <px>` so the doc pane (`.source`, `.doc-pane`, the cloud) lays out in
  the other half. A vertical divider uses the same drag logic as the existing doc split (`splitFrac`, saved as
  `chatSplitFrac`, clamped 0.25–0.75, double-click resets to 0.5).
- Chat header: the expand button becomes a small menu/cycle "Corner · Side by side · Full screen". Dragging the
  header in split mode swaps sides.
- When a doc split view (`split` state) is also open, the doc area keeps its own divider inside its half.
- Check: the find bar, area screenshots and annotation rail measure their container, not the window.

---

## Phase 2: notes

### 6. Right-click near the bottom cuts the menu off
Fixed by G3 (portal + max-height + scroll + fixed submenus). Test the notes menu with a selection at the very
bottom of a short window (640px min height), and the artifact viewer's Highlight submenu at the right/bottom edges.

### 7. One "Highlight" row with visible colours
- Notes menu (`NoteEditor.tsx:172`): replace the five "Highlight yellow…" items and "Remove highlight" with one
  **Highlight** submenu built exactly like the content viewer's (`ArtifactViewer.tsx:179`: swatch per colour,
  then "Remove highlight").
- Swatch colours come from the same table as the applied colour. `HL_COLORS` (hex) and `.sw-*` classes
  (rgb) currently differ, so: `MenuItem.swatch` accepts a CSS colour as well as a name, and both menus use one
  shared `HIGHLIGHTS` list (`components/highlights.ts`). That also fixes the missing orange swatch.
- Optional polish (same change): use the G3 `swatches` row instead of a submenu in both menus: "Highlight ● ● ● ●
  ● ⊘" in one line, one click instead of hover-then-click. **Default: do this in both places so they stay
  identical.**

### 8. A friendlier note toolbar
- Group into clear segments with icons, not glyphs: **Style** (paragraph style select), **Font** (font + size as
  one compact control), **Format** (B I U S, sub/sup in an overflow), **Colour** (text colour and highlight as
  split buttons: click applies the last used colour, the caret opens a **swatch popover** like Minibar's
  `.swatches`, not a text list of hex codes), **Paragraph** (lists, indent, alignment as a 3-way segmented
  control), **Insert** (line), **History** (undo/redo), and **Clear formatting** at the end.
- Active state: B/I/U/S/lists/alignment show pressed when `document.queryCommandState` says so (update on
  `selectionchange`, already partly done by `trackBlock`).
- The size select shows the current size instead of resetting to "Size".
- Narrow widths: segments wrap into a second row, or less-used ones go into a "⋯" overflow menu. No
  horizontal scroll.
- Tooltips keep the shortcuts. The highlight button's "right-click for more" goes away (the caret replaces it).
- Styles go in `5-features.css` under `.ne-toolbar`. Check the daylight theme.

### 5. Spell check in Australian English (changeable in Settings)
**Background:** Electron downloads Hunspell dictionaries from a Google CDN, and `lockToLocalhost`
(`main.cjs:114`) blocks that, so spell check may currently do nothing. **First step:** check what happens now
(look for `[blocked] …/dict/…` in the Electron console, type a misspelling in a note).
- Bundle `.bdic` files for `en-AU`, `en-GB`, `en-US` in `app/assets/dictionaries/` (from Chromium's
  `hunspell_dictionaries`). Then `session.setSpellCheckerDictionaryDownloadURL('file:///…/dictionaries/')`.
  If file URLs aren't accepted, serve them from the backend (`GET /spell/{name}` on 127.0.0.1, which the
  lock allows).
- Language: a pref `spellLanguage` (default `en-AU`, "Off" allowed). The preload exposes
  `studyApp.spell.setLanguages(['en-AU'])` → IPC → `session.setSpellCheckerLanguages`, called at startup and
  when changed. Settings → General gets a "Spelling" select: English (Australia), English (UK), English (US), Off.
- Note right-click menu: the editor uses its own menu, so Electron's never shows spelling suggestions. The
  sandboxed preload can use `webFrame.isWordMisspelled` / `getWordSuggestions`. Expose them as
  `studyApp.spell.check(word)`, and `studyApp.spell.addWord(word)` (IPC → `session.addWordToSpellCheckerDictionary`).
  When the right-clicked word (found from the caret position under the pointer) is misspelled, the menu opens
  with up to 5 suggestions (replacing the word through `execCommand('insertText')`, so native undo works), then
  "Add to dictionary".
- Also applies to the chat box and other text fields (Chromium spell-checks those itself once a dictionary loads).

### 4. Let the chat sit over the Comments panel
**Why:** `5-features.css:261` translates the right-docked chat 330px left whenever the note's Comments panel is
open, and docking only knows two corners. So the chat can never sit over the panel.
- Replace the forced translate with a docking choice: on drag release (`SubjectView.startDrag`), if the chat's
  centre is over `.reviews`, dock right **over** the panel (`dock-right over-reviews`, no offset). Otherwise
  keep today's beside-the-panel position. Saved as pref `chatOverReviews`.
- While dragging, the target (beside or over) is outlined so it's clear where the chat will land.
- Chat split mode (12) is unaffected: there the comments panel lives inside the note's half.

---

## Phase 3: lists and files

### 3. Drag to reorder to-dos, files and generated content
Reuses `components/reorder.ts` (already used for subjects, topics, folders), plus the migration-6 `position` columns.

- **To-dos** (`ResourcePanel` `Todos`): one group per subject. Open and done items stay separate (done sinks to
  the bottom, as now), so open items reorder among open ones. `POST /subjects/{sid}/todos/order {ids}`. List
  order: `ORDER BY done, position IS NULL, position, id DESC`.
- **Files** (`FileList` inside a topic, a folder, or the reference library): one group per container. Files are
  already `draggable` with `DOC_DRAG` (move to topic/folder, attach to chat), so `useReorder` gets an option to
  **add** its type to an existing drag instead of replacing it (`item(id, { carry: true })` sets both
  `ORDER_DRAG` and `DOC_DRAG`). Dropping on a sibling reorders; dropping anywhere else behaves as now.
  `POST /topics/{tid}/documents/order`, `POST /subjects/{sid}/references/order`. Inside folders the order is
  the same `documents.position`, filtered to the folder.
- **Generated content** (`LibraryPanel`): one group per *topic + calendar day*, so an item only moves among items
  created the same day and the date order of the list still holds. `POST /subjects/{sid}/artifacts/order {ids}`.
  `library()` sorts `ORDER BY date(created_at) DESC, position IS NULL, position, id DESC`.
- Each reorder registers an undo (previous id order → same endpoint).
- **Assumption to confirm:** "within its own day" applies to generated content only (it's the list showing
  dates). To-dos and files reorder freely within their own list or folder.

### 16. Search bar for content files
- `ResourcePanel` header gets a search field (also focused with Ctrl+Shift+F). It filters files by name
  across the reference library, every topic and folder. Matching topics and folders open, others hide, and
  match text is highlighted. Esc clears it and restores the previous open/closed state.
- Below the name matches, a **"In file text"** section (debounced 300 ms, ≥3 characters): `api.search` across the
  subject (`/search`, which already merges keyword + vector search, and goes keyword-only when embeddings are
  paused), grouped by file, showing the unit label and a snippet. Clicking one opens the document at that unit
  (`DocumentView.matchUnit`, like citations) **with the search term pre-filled in the find bar** (ties in with 9).
- `/search` currently takes a single `topic_id`. Add a subject-wide form (`subject_id`, topic optional) if it
  doesn't have one.

### 9. Find in a content file only searches rendered pages
**Why:** PDF pages render lazily (`views/source/layouts.tsx:75`, IntersectionObserver with an 800px margin), and
the text layer exists only for rendered pages. `FindBar` searches the DOM, so pages that haven't rendered never match.
- A **find provider** registry in `FindBar.tsx`: a renderer can register `{ search(q) → Hit[], reveal(hit) →
  Promise<Range | null> }` on its `data-find` root (WeakMap). Without one, the DOM search stays as it is.
- `PdfView` registers a provider that searches **every page's text** with `page.getTextContent()`, cached per
  document (and normalised the same way as `findAll`: case, whitespace, ligatures). The count is the true total
  ("3/41"). `reveal` scrolls the page into view, forces it to render (`setVisible(true)`), waits for its
  `TextLayer`, then maps the hit's character offset to a DOM Range so the usual `find-current` highlight paints.
- Word/HTML fallback layouts and slides are fully in the DOM, so they keep the plain search. Check the slide
  composer (`compose_slide`) layout too.
- Test on a long PDF from `spike/samples/Physics`: search a word that only appears near the end without
  scrolling, and step through all hits.

---

## Phase 4: app-wide

### 18. Undo and redo for the whole app
Two kinds of history in one stack (`app/src/undo.ts`):

1. **Navigation**: opening/closing a document, artifact or note, switching subject or Settings, opening
   a split, changing chat mode. `SubjectView` and `App` push a snapshot `{route, centre: {doc, page, split,
   chatMode}}` whenever these change (deduped; scroll position optional, later). Undo restores the previous
   snapshot, so "open a content file → undo" returns to where you were.
2. **Edits**: anything with a cheap inverse calls `undoable({ label, undo, redo })`:
   chat delete/restore (2), rename (chat, artifact, note, topic, subject), to-do add/done/delete (re-add with
   the same text/topic/position), every reorder (3), topic/folder moves of files (`relink` already makes moves
   cheap), highlights (`artifact_marks` add/remove), annotation add/remove.

- **Out of scope:** irreversible deletes (documents, artifacts, subjects) keep their confirm dialogs. Making them
  undoable needs soft delete for files and vectors, which is bigger; listed as a follow-up.
- Controls: ↶ ↷ buttons in the titlebar (left of the window buttons) with tooltips naming the action
  ("Undo: open ‘Lecture 3.pdf’"). **Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z** go to the app stack only when focus isn't in
  an input, textarea or contentEditable. Inside those, the native text undo keeps working (the note editor
  already depends on it).
- Stack: 100 entries, in memory (cleared on restart). A new action clears redo. An undo whose inverse fails (e.g. the
  item was deleted meanwhile) shows a toast and is dropped.
- Toasts: a small `components/toast.tsx` ("Chat deleted · Undo"), also used by 2. It's new; `overlay.tsx` has
  no toast today.

---

## Testing and checks

- Backend: `cd backend && uv run pytest` with new tests in `tests/test_qol.py`: empty-chat reuse (1), soft delete
  + restore + purge (2), stop saves the partial reply (14, using a fake `llm.chat_stream`), usage summing across
  tool rounds (G2), `/stats` and `/context` shapes, order endpoints (3). Update `tests/test_api_contract.py` for
  the new `api.ts` types.
- Frontend: `npx tsc --noEmit`, `npx vite build`.
- Live check against a throwaway data dir on port 47616 (`?backend=47616&token=…`), never the user's own
  47615/5173. Covers: 15 (switch chats/subjects mid-reply), 11 (dots across subjects), 14 (stop mid-reasoning
  and mid-prefill), 12 (split resize, find bar in split), 9 (long PDF), 6 (menu at the window bottom), 5 (only
  testable in Electron: `APOLLO_DATA_DIR=<tmp> npm run dev`).
- Update `CLAUDE.md` where architecture changes: chat stream store, find providers, undo stack, chat modes,
  spell dictionaries.

## Decisions (answered 2026-11-07)

1. **3:** "within its own day" applies to generated content only. To-dos and files reorder freely in their list.
2. **2:** deleting a chat from the sidebar **keeps a confirm dialog**. The × opens it; soft delete + Undo stay
   as a safety net.
3. **7:** inline colour dots **plus a custom colour picker**, in both the note menu and the content viewer menu.
4. **18:** navigation + reversible edits. **Everything destructive gets a confirmation popup.**

## Added items

### 19. Multi-select and bulk delete of files and chats
- Files already support Ctrl/Shift-click picking (`Picker` in `FileList`, owned by `ResourcePanel`). Add a bulk
  **Delete** (right-click on a picked file, and the Delete key) with one confirmation listing the count.
- Chats in `ChatHistory`: Ctrl-click toggles, Shift-click selects a range (in display order). A selection bar
  shows "n selected · Delete · Clear". Delete key works too. One confirmation, then
  `POST /chats/delete {ids}` (soft delete) and an Undo entry restoring them all.

### 20. Command palette (Ctrl+K)
- `components/CommandPalette.tsx`, mounted in `App`. Ctrl+K opens it anywhere (even in text fields). Fuzzy
  search over: subjects, topics, files, generated content, notes, chats (of all subjects), plus actions
  (new chat, new note, settings tabs, toggle chat mode, undo/redo, jobs).
- Data from one backend call `GET /palette` (ids, titles, kinds, subject ids), cached while open.
- Picking an item navigates through `App` (`go(route)`), and `SubjectView` accepts an `open` request in the
  route (`{ doc | artifact | note | chat }`) so it can open things inside a subject.

## Status (2026-11-07)

Backup before any change: `Desktop\AI\Study\backups\apollo-2026-11-07` (`study\` = the whole project, `data\` = the
app's data folder with a consistent copy of `study.db`; the `backups\` subfolder wasn't copied, it holds older backups).

All 20 items are implemented. Checked against a copy of the real data (test backend, browser preview):
one blank chat at a time; × and bulk delete ask first, undo restores; reply stays in its own chat when switching;
stop keeps the partial reply ("Stopped"); unread dots on chat and subject; `/stats`, `/effort`, `/context`, `/help`;
context meter; Ctrl+K palette (search, open in another subject); to-do and same-day generated-content reorder with
undo (cross-day refused); sidebar file search incl. text hits that open the file with the find bar filled in; PDF find
counts matches on pages not drawn yet; note menu at the window bottom moves up and scrolls; colour dots + custom
colour; toolbar pressed states; side-by-side chat mode; Ctrl+Z/Ctrl+Y navigation.

Not verified visually (the preview pane was hidden): the side-by-side layout and divider, the chat docking over the
Comments panel, the PDF find scrolling to a match on an undrawn page, the new toolbar's look.

Later the same day (see `IMPROVEMENT_PLAN.md`, Follow-ups): the chat's layout menu (item 12) became separate side-by-side
and full-screen buttons, and the find bar (item 9) can be dragged and closes when its content is switched.

Spell check (item 5): Chromium dictionaries for en-AU / en-GB / en-US are bundled in `app/assets/dictionaries`
(about 1.3 MB, from Chromium's hunspell_dictionaries repo). Tested in Electron offline: they load with no download
attempt, en-AU flags "color" (suggests "colour"), and the note editor gets Chromium's own spelling result for its
menu (Electron's in-page word check, `webFrame.isWordMisspelled`, always answered "not misspelled", so it isn't used).
