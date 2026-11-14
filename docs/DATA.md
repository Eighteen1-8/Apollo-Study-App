# Where Apollo Study keeps things

Everything stays on this computer. There are three places, and only the first is your library.

## 1. The data folder (your library)

`%APPDATA%\Apollo Study\data\` (Settings → Maintenance → **Open data folder**)

| Path | What it is | Safe to delete? |
|---|---|---|
| `study.db` (+ `-wal`, `-shm`) | The database: subjects, topics, folders, each file's parsed text, vision notes and embeddings, chats, generated content, your notes, attempts, ratings, to-dos, annotations, the knowledge cloud's layout, settings | **No.** This is the library. Close the app before copying it. |
| `files\` | The original files you added, stored once by content (`<sha256>.<ext>`) | No (Maintenance → Clean up removes ones no file uses) |
| `renders\` | Exact PDF copies of PowerPoint and Word files, for the viewer and vision | Yes: made again when needed (needs Office or LibreOffice) |
| `assets\<n>\` | Images taken from file *n* and the page images vision saw | Mostly: vision previews and figures need them |
| `assets\figures\`, `assets\chat\` | Figures cropped for notes and chat; images and screenshots sent to the chat | Clean up removes the unused ones |
| `backups\` | Copies of `study.db`: daily, before app updates, before restores, and your own (Maintenance → Backups) | Yes, but they're how you undo a mistake |
| `logs\backend.log` | The app's log, 5 × 2 MB rotating (Maintenance → **Open log**) | Yes |
| `backend-token` | The running backend's access token (changes every start) | Yes |
| `restore-pending` | Only while a restore is scheduled for the next start | Cancel it in Maintenance instead |

API keys (OpenRouter, custom endpoints) are stored in `study.db` **encrypted for your Windows account** (DPAPI). A copy of
the database opened by another Windows account or on another PC shows them as not set. Enter them again there.

## 2. Window state (Electron)

`%APPDATA%\Apollo Study\` (beside `data\`)

| File | What it is |
|---|---|
| `window-state.json` | Window size, position and whether it was maximised |
| `window-chrome.json` | The title bar colours of the last theme, so the next start doesn't flash white |
| `spelling.json` | The spell-check language (Settings) |
| `Dictionaries\` | The spell-check dictionaries, copied from the app at each start (nothing is downloaded) |

All are rewritten automatically and can be deleted.

## 3. Per-machine preferences (in the app's browser storage)

These live in the app's own browser profile, not in the database, so they don't follow a backup, a study pack or a new PC.
`app/src/prefs.ts` lists them:

- **Appearance:** theme, accent colour, reduced motion, knowledge cloud on or off, its idle drift and frame rate (`apollo.appearance`)
- **Workspace:** sidebar widths and folded sidebars (`sides`), the split view's divider (`splitFrac`), heights of the chat list and My notes (`split:chats`, `split:notes`), folded sidebar sections (`chatsFolded`, `notesFolded`, `todosFolded`)
- **Chat:** the floating chat's corner and size (`chatSide`, `chatSize`), side by side and its width (`chatSplit`, `chatSplitFrac`), docked over the Comments panel (`chatOverReviews`), reasoning level (`chatReasoning`), unread dots (`chatUnread`)
- **Notes:** the toolbar's last text and highlight colours (`noteTextColor`, `noteHighlight`)
- **Generated list:** folded topic groups per subject (`libCollapsed:<subject id>`)
- **Document viewer:** minimap and annotations rail shown or hidden (`minimap`, `annoRail`)
- **Exams:** answers typed into an exam and not submitted yet (`examDraft:<content id>`)

The order you dragged things into and the folders inside topics are *not* in this list: they're in the database, so
they move with it.

## Deleted things

Deleted chats, generated content and notes stay in the database for a week (Undo, or Ctrl+Z, brings them back) and are
removed for good at the first start after that. Deleted files, topics and subjects are removed at once (the app asks
first); a backup is the only way back.

## Moving to a new PC

1. On the old PC, close Apollo Study and copy the whole `%APPDATA%\Apollo Study\data\` folder.
2. On the new PC, run Apollo Study once and close it, then replace its `data\` folder with the copy.
3. Enter your API keys again if you use online models (they were encrypted for the old account).
4. Appearance and layout preferences start from the defaults.

To share a subject with classmates instead, use **Settings → Share** (a study pack carries files, text, vision notes and
embeddings; not your chats, generated content or progress).

## If the app won't start

- Electron shows the backend's own error message. "Updating the database failed" means a database update hit a problem:
  your data was backed up first (`backups\…-before-update.db`).
- To go back to a backup by hand: close the app, rename `study.db` (and delete `study.db-wal` / `study.db-shm`), then copy
  the backup in as `study.db`.
- `logs\backend.log` has the details.
