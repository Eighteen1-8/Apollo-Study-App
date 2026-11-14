/* An editor's own undo / redo (mind maps and drawings): whole snapshots, since their data is small and immutable.
   Ctrl+Z / Ctrl+Y act on it while the editor's canvas has the focus; the app-wide stack (src/undo.ts) is left alone. */

export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private limit = 200) {}

  /** Remember `before` as the state to go back to (call before applying a change). */
  push(before: T) {
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future.length = 0;
  }

  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  clear() { this.past.length = 0; this.future.length = 0; }
}
