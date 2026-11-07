/* App-wide undo and redo (titlebar ↶ ↷, Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z outside text fields; text fields keep their own).
   Two kinds of entries share one stack: navigation (opening a file, a note, generated content, another subject: undo
   goes back to what was showing) and edits with a cheap inverse (deleting chats, renames, to-dos, reorders, moves).
   Deleting files, generated content or subjects can't be undone; those always ask first. In memory only. */
import { useSyncExternalStore } from 'react';
import { toast } from './components/toast';

export interface UndoEntry {
  /** What was done, lower case: "open ‘Lecture 3.pdf’", "delete 3 chats". */
  label: string;
  undo: () => unknown;
  redo: () => unknown;
  kind?: 'nav' | 'edit';
}

const LIMIT = 100;
const past: UndoEntry[] = [];
const future: UndoEntry[] = [];
const listeners = new Set<() => void>();
let version = 0;
let applying = false;
const emit = () => { version++; listeners.forEach((fn) => fn()); };

/** True while an undo or redo is being applied: navigation it causes isn't recorded as a new step. */
export const isApplying = () => applying;

export function undoable(e: UndoEntry): UndoEntry {
  // navigation an undo causes isn't a new step; an edit is (even one made straight after an undo)
  if (applying && e.kind === 'nav') return e;
  past.push(e);
  if (past.length > LIMIT) past.shift();
  future.length = 0;
  emit();
  return e;
}

async function run(from: UndoEntry[], to: UndoEntry[], e: UndoEntry, which: 'undo' | 'redo') {
  applying = true;
  try {
    await e[which]();
    to.push(e);
    if (e.kind !== 'nav') toast(`${which === 'undo' ? 'Undone' : 'Redone'}: ${e.label}`);
  } catch (err) {
    toast(`Couldn't ${which} ${e.label}: ${String(err).replace(/^Error: /, '')}`);
  } finally {
    // navigation lands asynchronously (state updates, a remount): keep ignoring it for a moment
    setTimeout(() => { applying = false; }, 120);
    void from;
    emit();
  }
}

export async function undo() {
  const e = past.pop();
  if (e) await run(past, future, e, 'undo');
}
export async function redo() {
  const e = future.pop();
  if (e) await run(future, past, e, 'redo');
}
/** Undo one particular entry (a toast's Undo button), wherever it is in the stack. */
export async function undoEntry(e: UndoEntry) {
  const i = past.lastIndexOf(e);
  if (i < 0) return;
  past.splice(i, 1);
  await run(past, future, e, 'undo');
}

export function useUndo() {
  useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, () => version);
  return {
    canUndo: past.length > 0, canRedo: future.length > 0,
    undoLabel: past[past.length - 1]?.label, redoLabel: future[future.length - 1]?.label,
  };
}

const editable = (el: Element | null) => !!el?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');

/** Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z for the app, unless a text field has focus (it keeps its own undo). */
export function installUndoKeys() {
  const key = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || editable(document.activeElement)) return;
    if (document.querySelector('.modal-backdrop')) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); } else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  };
  window.addEventListener('keydown', key);
  return () => window.removeEventListener('keydown', key);
}
