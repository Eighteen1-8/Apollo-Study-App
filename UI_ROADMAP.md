# UI overhaul roadmap

Phase 1 (done in this pass) laid the foundation. The phases after it are ordered so each one builds on the last,
and every phase ships on its own.

## Phase 1: foundation (done)

- **Theme system** (`app/src/theme.ts`, `styles-v4.css`). There are five themes: Midnight, Aurora, Nebula,
  Graphite and Daylight (light). You can also pick an accent colour from a set or a custom picker. Accent tints
  (`--accent-strong`, `--accent-soft`, `--accent-glow`) are worked out from `--accent` with `color-mix`. The choice
  is saved per machine in localStorage and applied before the first render. Colours fade over smoothly when the theme
  changes.
- **Motion**: shared easing tokens (`--ease-out`, `--ease-spring`), page entrances, staggered card reveals,
  spring hovers, button sheen, animated progress bars, modal, menu and toast entrances, and message slide-ins.
  The "Reduce motion" setting and the Windows setting both turn these off.
- **Surfaces**: glass panels (backdrop blur) on the minibar, side panels, floating chat, modals, menus and
  popovers. An ambient backdrop sits behind everything: drifting glows plus a faint dot grid.
- **Home page**: a hero with a greeting, live stats and actions. Subject cards have a glow and border that follow
  the cursor.
- **Knowledge cloud** (`components/EmbeddingCloud.tsx` + `GET /embeddings/map` in `backend/studyapp/projection.py`).
  Chunk embeddings are reduced to 3D with PCA. Each chunk is a glowing node, coloured by subject, and chunks of
  the same file are threaded together in reading order. Ambient dust and a star shell give it depth.
  - Controls: drag to orbit (with inertia), scroll to zoom, double-click to reset.
  - Hovering a node shows its label, file and topic, and lights up that file. The legend highlights a subject.
    Clicking a node opens its subject.
  - When nothing is embedded yet, a placeholder galaxy is shown. The cloud pauses while it is off-screen.

## Phase 2: theme coverage and consistency

- Find the colours that are still hard-coded in `styles.css`, `styles-v2.css` and `styles-v3.css` (`rgba(124, 140, 255, …)`,
  `#0b0d1a`, the pastel `.t-*`/`.ext-*` tints, and the sticky-note yellows). Move them to tokens so Daylight is
  correct on every screen, especially the viewer, annotations, quiz and exam screens.
- Give the source viewer's page background (`.source-scroll`) a token per theme. Add an optional "dim pages" filter
  for dark themes.
- Merge the four style layers into one token file plus per-feature files (`tokens.css`, `base.css`, `chat.css`,
  `viewer.css`, …). Remove the overrides that v3/v4 now duplicate.
- Make the subject colour picker offer palettes that suit the current theme.

## Phase 3: motion system 2.0

- **Shared-element transitions** with the View Transitions API (Chromium in Electron supports it): a subject card
  morphs into the workspace header, a library item expands into the full-screen viewer, and a citation chip flies
  to the page it opens.
- **Layout animations** when lists reorder or items are added or removed (FLIP technique): to-dos, the library,
  topics and the jobs list.
- **Streaming polish**: fade tokens in as they stream, animate the reasoning block open and closed, and use a
  skeleton shimmer while figures resolve.
- Spring-based drag physics for the floating chat (snapping to corners with overshoot), plus a small "magnetic"
  pull on primary buttons.

## Phase 4: navigation and layout

- **Command palette** (Ctrl+K): jump to a subject, topic, file or chat, run actions (new flashcards, switch
  theme), and search across everything. It reuses `/search`.
- Collapsible, resizable side panels whose widths are remembered. A focus mode hides both panels.
- Breadcrumb header in the workspace (Subject › Topic › File) with keyboard navigation.
- A custom title bar in Electron (frameless window) so the app feels native and the glass effect reaches the top edge.

## Phase 5: knowledge cloud upgrades

- **WebGL renderer** (`three` or raw WebGL2) so 10k+ points stay at 60 fps, with bloom, depth of field and
  instanced sprites. The current Canvas 2D renderer stays as the fallback.
- **Better projection**: UMAP or t-SNE run once in a background job and cached in the DB, so clusters separate
  more clearly than with PCA.
- **Semantic search in the cloud**: type a query, it is embedded, and a "probe" flies to the nearest chunks and
  lights them.
- **Topic clusters**: hulls or labels around each topic's centroid, and an animated fly-to when a subject is picked.
- A mini cloud in each subject workspace, scoped to that subject, where clicking a node opens the exact slide or
  page through the citation resolver.

## Phase 6: study experience

- A redesigned flashcard deck: stacked 3D cards with swipe gestures (left = struggling, right = confident), streak
  counters and a session summary.
- Quiz: progress shown as a ring, celebration particles on a perfect score, and a timeline review of answers.
- Dashboard widgets on the home page: study streak, cards due, recent artifacts, and jobs in flight.
- Optional subtle sound effects (local audio files only), off by default.

## Phase 7: quality

- Visual regression snapshots for each theme, using Playwright against the Vite build.
- Accessibility pass: contrast checks per theme, focus order, ARIA on custom menus and dialogs, and keyboard
  control of the cloud.
- Performance budget: split the bundle (pdf.js and KaTeX loaded on demand; the main chunk is about 1 MB today) and
  watch frame time while chat streams.
