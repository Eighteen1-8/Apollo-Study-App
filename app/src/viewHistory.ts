/* What the subject workspace is showing (a document, a page, a split pane), so undo can go back to it, even after
   switching subject: App routes back with `view`, and SubjectView opens it on mount. */
export type PaneRef = { kind: 'artifact' | 'note' | 'doc'; id: number; nonce: number };
export interface ViewSnap {
  doc: { id: number; focus?: string } | null;
  page: { kind: 'artifact' | 'note'; id: number } | null;
  split: PaneRef | null;
}
/** Something to open once a subject shows (the Ctrl+K palette). */
export type OpenRequest = { kind: 'doc' | 'artifact' | 'note' | 'chat' | 'topic'; id: number; nonce: number };

/** The last view of each subject, read when leaving it (App records the route change for undo). */
export const currentView = new Map<number, ViewSnap>();

let mounted: { subjectId: number; restore: (s: ViewSnap) => void } | null = null;
let routeTo: ((subjectId: number, view: ViewSnap) => void) | null = null;

export function registerWorkspace(subjectId: number, restore: (s: ViewSnap) => void) {
  const me = { subjectId, restore };
  mounted = me;
  return () => { if (mounted === me) mounted = null; };
}
export function registerRouter(fn: (subjectId: number, view: ViewSnap) => void) { routeTo = fn; }

/** Show `snap` in that subject: in place when it's on screen, otherwise by routing there. */
export function showView(subjectId: number, snap: ViewSnap) {
  if (mounted?.subjectId === subjectId) mounted.restore(snap);
  else routeTo?.(subjectId, snap);
}
