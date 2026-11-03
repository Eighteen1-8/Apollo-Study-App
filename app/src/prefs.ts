/** Per-machine UI preferences, kept in this browser profile's localStorage (not in the database, so they don't follow a
 * backup, a study pack or a new PC). Every key in one place:
 *   apollo.appearance  theme, accent, motion, cloud (theme.ts)
 *   sides              workspace sidebar widths and folded state (SubjectView)
 *   chatSide, chatSize floating chat corner and size (SubjectView)
 *   chatReasoning      the chat's reasoning level (ChatView)
 *   libCollapsed:<id>  folded topic groups in a subject's Generated list (LibraryPanel)
 *   minimap, annoRail  document viewer panels shown or hidden (SourceView)
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
