/* "Insert into the open note": the one way anything outside the note editor puts content into a student's note (the
   calculator's results and graphs, "Add to notes" on a file's selection or screenshot, "Add to my notes" on part of
   Apollo's answer, and drops into the note).
   - A rich-text note editor registers itself while it's open (`registerNoteInsert`); the latest one wins. It inserts
     with insertHTML where its caret last was (the end if it never had the focus), so the editor's own Ctrl+Z takes it
     out again, and autosaves. Mind maps and drawings don't register: they aren't targets.
   - With no note open, a caller asks for one to be opened beside what's showing (`openNoteBeside`, which SubjectView
     provides) and queues the content for it (`queueForNote`); the editor takes the queue once the note has loaded.
   The HTML builders below are pure, so they're unit-tested. Notes can't hold classes (NoteEditor's clean()), so a
   source line is plain text, not a citation link. */
import { useSyncExternalStore } from 'react';
import type { NoteSummary } from './api';

export type NoteInsert = (html: string) => void;
export interface NoteTarget { insert: NoteInsert; noteId?: number; title?: () => string }

const targets: NoteTarget[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const sub = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** The note editor offers itself as the place inserts go (the latest one registered wins). Returns the unregister. */
export function registerNoteInsert(fn: NoteInsert, info: { noteId?: number; title?: () => string } = {}): () => void {
  const t: NoteTarget = { insert: fn, ...info };
  targets.push(t);
  emit();
  return () => {
    const k = targets.lastIndexOf(t);
    if (k >= 0) targets.splice(k, 1);
    emit();
  };
}
/** The open note (the most recently opened), or null. */
export const currentNoteTarget = (): NoteTarget | null => (targets.length ? targets[targets.length - 1] : null);
export const currentNoteInsert = (): NoteInsert | null => currentNoteTarget()?.insert ?? null;
export const useNoteInsert = () => useSyncExternalStore(sub, currentNoteInsert);
export const useNoteTarget = () => useSyncExternalStore(sub, currentNoteTarget);

// ---- a note to open beside what's showing, and what to put in it once it has loaded
let opener: ((noteId: number) => void) | null = null;
/** SubjectView: how to open a note beside the file (or chat) the content came from. Returns the unregister. */
export function registerNoteOpener(fn: (noteId: number) => void): () => void {
  opener = fn;
  return () => { if (opener === fn) opener = null; };
}
export const openNoteBeside = (noteId: number): boolean => { if (!opener) return false; opener(noteId); return true; };
const pending = new Map<number, string[]>();
export function queueForNote(noteId: number, html: string) { pending.set(noteId, [...(pending.get(noteId) ?? []), html]); }
/** The editor of `noteId`, once its content has loaded: what to insert (and forget). */
export function takeQueued(noteId: number): string[] {
  const list = pending.get(noteId) ?? [];
  pending.delete(noteId);
  return list;
}

// ---- what goes in
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);
/** "Lecture 3.pdf · Page 4" (just the file without a label). */
export const sourceLine = (file: string, label?: string | null) => (label ? `${file} · ${label}` : file);
const paragraphs = (text: string) => text.replace(/\r\n?/g, '\n').trim().split(/\n{2,}/)
  .map((p) => escapeHtml(p.trim()).replace(/\n/g, '<br>')).filter(Boolean);
/** A quote block holding `text`, with a small source line under it, and an empty paragraph after it so typing goes on
 * outside the quote. */
export function quoteHtml(text: string, source: string): string {
  const body = paragraphs(text).map((p) => `<p>${p}</p>`).join('') || '<p><br></p>';
  return `<blockquote>${body}<p><small>— ${escapeHtml(source)}</small></p></blockquote><p><br></p>`;
}
/** A picture (a data: URL) with its source line under it. */
export function imageHtml(src: string, source: string): string {
  return `<p><img src="${escapeHtml(src)}" alt="${escapeHtml(source)}" style="max-width: 100%;"></p>`
    + `<p><small>— ${escapeHtml(source)}</small></p><p><br></p>`;
}
/** The same as text, for a plain-text drop (another app, the chat box). */
export const quotePlain = (text: string, source: string) => `“${text.trim()}”\n— ${source}`;

/** Rich-text notes only (maps and drawings can't take text or pictures), most recently changed first. */
export function recentNotes(list: NoteSummary[], n = 6): NoteSummary[] {
  return list.filter((x) => (x.kind ?? 'note') === 'note').sort((a, b) => b.updated_at - a.updated_at).slice(0, n);
}

// ---- drags into a note
/** Marks a drag whose text/html is ours (a quote with its source line): the note inserts it at the drop point. */
export const QUOTE_DRAG = 'application/x-apollo-quote';
/** A screenshot area of a file still to be taken: {document_id, unit, rect, source}. */
export const AREA_DRAG = 'application/x-apollo-area';
export type AreaDrag = { document_id: number; unit: number; rect: [number, number, number, number]; source: string };

/** Fill a drag with a quote: plain text and HTML (with the source line) plus the marker. */
export function setQuoteDrag(dt: DataTransfer, text: string, source: string) {
  dt.setData('text/plain', quotePlain(text, source));
  dt.setData('text/html', quoteHtml(text, source));
  dt.setData(QUOTE_DRAG, '1');
  dt.effectAllowed = 'copy';
}
