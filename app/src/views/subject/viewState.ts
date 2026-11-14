/* What the subject workspace's centre shows: an open document or page, an optional second pane beside it, and whether
   the chat covers it all. One reducer, so undo/redo's snapshot (`snapOf`) and restore (`restore`) are one value each. */
import type { AreaSource } from '../../api';
import type { ViewSnap } from '../../viewHistory';

/** What the second pane of split view shows: generated notes / a cheat sheet / a mind map, a note of the student's,
 * or a document. */
export type SplitPane = { kind: 'artifact' | 'note' | 'doc'; id: number; nonce: number };
export type DocView = { id: number; focus?: string; nonce: number; details: boolean; pulse?: AreaSource };
/** Generated notes / cheat sheet / mind map, or one of the student's own notes. */
export type PageView = { kind: 'artifact' | 'note'; id: number };

export interface View { doc: DocView | null; page: PageView | null; split: SplitPane | null; chatFull: boolean }

export type ViewAction =
  | { type: 'doc'; id: number; focus?: string; details?: boolean; pulse?: AreaSource }
  | { type: 'page'; kind: PageView['kind']; id: number }
  | { type: 'details'; on: boolean }
  | { type: 'split'; pane: Omit<SplitPane, 'nonce'> }
  | { type: 'closeSplit' }
  | { type: 'swap' }
  /** Close the first pane; with a second pane open, that one takes its place. */
  | { type: 'closePrimary' }
  | { type: 'clear' }
  | { type: 'restore'; snap: ViewSnap }
  | { type: 'chatFull'; on: boolean }
  /** Something dragged from a sidebar and dropped on one of the centre's drop zones (`dropZones`). */
  | { type: 'place'; pane: Omit<SplitPane, 'nonce'>; where: DropWhere };

/** Where a pane dropped in the centre goes: `open` (nothing is open), `replace` what's open (nothing split), or the
 * `left` / `right` side (a new second pane, or replacing that side when split). */
export type DropWhere = 'open' | 'replace' | 'left' | 'right';
/** The drop zones the centre offers for a view, left to right. */
export function dropZones(v: Pick<View, 'doc' | 'page' | 'split'>): DropWhere[] {
  if (!v.doc && !v.page) return ['open'];
  return v.split ? ['left', 'right'] : ['left', 'replace', 'right'];
}
/** Which zone a point is over: `frac` is how far across the centre it is (0 = left edge). */
export function zoneAt(zones: DropWhere[], frac: number): DropWhere {
  const i = Math.min(zones.length - 1, Math.max(0, Math.floor(frac * zones.length)));
  return zones[i];
}
/** Where a note opened "beside" what's showing goes (Add to notes): beside a file, never over it. */
export function besideWhere(v: Pick<View, 'doc' | 'page' | 'split'>): DropWhere {
  if (!v.doc && !v.page) return 'open';
  return v.split?.kind === 'doc' && !v.doc ? 'left' : 'right';
}

let tick = 0;
/** A fresh key that remounts a viewer (Date.now() alone can repeat within a millisecond). */
const nonce = () => Date.now() * 1000 + (tick = (tick + 1) % 1000);

const asPrimary = (p: SplitPane): Pick<View, 'doc' | 'page'> => (p.kind === 'doc'
  ? { doc: { id: p.id, nonce: nonce(), details: false }, page: null }
  : { doc: null, page: { kind: p.kind, id: p.id } });

const primaryPane = (v: View): SplitPane | null => (v.doc ? { kind: 'doc', id: v.doc.id, nonce: nonce() }
  : v.page ? { kind: v.page.kind, id: v.page.id, nonce: nonce() } : null);

export function viewReducer(v: View, a: ViewAction): View {
  switch (a.type) {
    case 'doc':
      return { ...v, doc: { id: a.id, focus: a.focus || undefined, nonce: nonce(), details: !!a.details, pulse: a.pulse }, page: null, chatFull: false };
    case 'page':
      return { ...v, doc: null, page: { kind: a.kind, id: a.id }, chatFull: false };
    case 'details':
      if (!v.doc) return v;
      // back from details remounts the viewer; into details keeps its key
      return { ...v, doc: { ...v.doc, details: a.on, nonce: a.on ? v.doc.nonce : nonce() } };
    case 'split':
      return { ...v, split: { ...a.pane, nonce: nonce() }, chatFull: false };
    case 'closeSplit':
      return { ...v, split: null };
    case 'swap': {
      const first = primaryPane(v);
      if (!v.split || !first) return v;
      return { ...v, ...asPrimary(v.split), split: first };
    }
    case 'closePrimary':
      if (v.split) return { ...v, ...asPrimary(v.split), split: null };
      return { ...v, doc: null, page: null, chatFull: false };
    case 'clear':
      return { ...v, doc: null, page: null };
    case 'restore':
      return { doc: a.snap.doc ? { ...a.snap.doc, nonce: nonce(), details: false } : null, page: a.snap.page, split: a.snap.split, chatFull: false };
    case 'chatFull':
      return v.chatFull === a.on ? v : { ...v, chatFull: a.on };
    case 'place': {
      const first = primaryPane(v);
      if (a.where === 'open' || !first) return { ...v, ...asPrimary({ ...a.pane, nonce: 0 }), split: null, chatFull: false };
      if (a.where === 'replace') return { ...v, ...asPrimary({ ...a.pane, nonce: 0 }), chatFull: false };
      if (a.where === 'right') return { ...v, split: { ...a.pane, nonce: nonce() }, chatFull: false };
      // left: the new one is first; what was first moves beside it unless something is already there
      return { ...v, ...asPrimary({ ...a.pane, nonce: 0 }), split: v.split ?? first, chatFull: false };
    }
  }
}

/** What undo/redo records of a view. */
export const snapOf = (v: View): ViewSnap => ({ doc: v.doc ? { id: v.doc.id, focus: v.doc.focus } : null, page: v.page, split: v.split });
/** Two views that undo would treat as the same step. */
export const viewKey = (v: View) => JSON.stringify([v.doc?.id ?? null, v.page, v.split ? [v.split.kind, v.split.id] : null]);
