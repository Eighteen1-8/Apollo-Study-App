/** Per-machine UI preferences, kept in this browser profile's localStorage (not in the database, so they don't follow a
 * backup, a study pack or a new PC). Every key in one place:
 *   apollo.appearance  theme, accent, motion, cloud, cloud drift, frame rate, advanced mode, UI size, background effect,
 *                      the pet and the migrations version (theme.ts)
 *   sides              workspace sidebar widths and folded state (SubjectView)
 *   chatSide, chatSize floating chat corner and size (SubjectView)
 *   chatReasoning      the chat's reasoning level (ChatView)
 *   libCollapsed:<id>  folded topic groups in a subject's Generated list (LibraryPanel)
 *   minimap, annoRail  document viewer panels shown or hidden (SourceView)
 *   split:chats, split:notes  heights of the chat list / my notes inside the sidebars (SplitHandle)
 *   splitFrac          split view: the first pane's share of the centre's width (SubjectView)
 *   chatSplit, chatSplitFrac  chat side by side with the document, and its share of the centre (SubjectView)
 *   chatOverReviews    the floating chat docked over a note's Comments panel instead of beside it (SubjectView)
 *   chatUnread         chats whose reply finished while you were elsewhere: their dots (chatStreams.ts)
 *   noteTextColor, noteHighlight  the note toolbar's last text / highlight colour (NoteEditor)
 *   chatsFolded, notesFolded, todosFolded, booksFolded  folded sidebar sections (LibraryPanel, MyNotes, Todos, ResourcePanel)
 *   todosDoneOpen      the to-do list's Completed group unfolded (Todos)
 *   drawTool, drawColor, drawWidth  the drawing editor's last tool, ink colour and thickness (views/notes/DrawingEditor)
 *   examDraft:<id>     answers typed into an exam and not submitted yet (Exam), so closing the viewer keeps them
 *   float:<key>        where a floating thing was dragged to: float:find, float:calc, float:pet (floating.tsx)
 *   calc               the calculator's mode, degrees/radians, graph functions and history (Calculator)
 *   studyTimer         the study timer's length, end time while running, or time left while paused, its preset
 *                      (custom, 25 / 5, 50 / 10), focus or break phase, and the custom length (timer.ts)
 *   studyToday         today's finished focus sessions and minutes, with the local date they belong to (timer.ts)
 *   tourPending        the subject-page tour waits to start after setup (SetupWizard, Tour)
 *   tourSeen.<id>      a feature's tour has been shown, so it doesn't start by itself again (Tour)
 * The spell-check language is kept by Electron itself (userData/spelling.json, main.cjs).
 * Reads and writes never throw: storage can be unavailable (then defaults apply and nothing is saved). */
export function getPref<T = string>(key: string, fallback: T, parse: (v: string) => T = (v) => v as unknown as T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : parse(v);
  } catch {
    return fallback;
  }
}

export function setPref(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: not saved */ }
}

export function removePref(key: string) {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}
