/** Per-machine UI preferences, kept in this browser profile's localStorage (not in the database, so they don't follow a
 * backup, a study pack or a new PC). Every key in one place:
 *   apollo.appearance  theme, accent, motion, cloud, cloud drift and frame rate (theme.ts)
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
 *   chatsFolded, notesFolded, todosFolded  folded sidebar sections (LibraryPanel, MyNotes, Todos)
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
