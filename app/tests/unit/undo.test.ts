import { afterEach, describe, expect, it, vi } from 'vitest';
import { isApplying, redo, undo, undoable } from '../../src/undo';

describe('undo stack', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('undoes and redoes in order, and a new edit clears the redo list', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const entry = (n: string) => ({ label: n, undo: () => { log.push(`undo ${n}`); }, redo: () => { log.push(`redo ${n}`); } });
    undoable(entry('a'));
    undoable(entry('b'));
    await undo();
    await undo();
    await redo();
    expect(log).toEqual(['undo b', 'undo a', 'redo a']);
    undoable(entry('c'));
    await redo(); // nothing to redo: b was dropped when c was added
    expect(log).toEqual(['undo b', 'undo a', 'redo a']);
    await undo();
    expect(log.at(-1)).toBe('undo c');
    vi.runAllTimers();
  });

  it('ignores navigation recorded while an undo is being applied', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    undoable({ label: 'nav', kind: 'nav', undo: () => { undoable({ label: 'echo', kind: 'nav', undo: () => log.push('echo'), redo: () => {} }); }, redo: () => {} });
    await undo();
    expect(isApplying()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(isApplying()).toBe(false);
    await undo(); // the echo was never recorded, so this finds nothing of it
    expect(log).toEqual([]);
  });

  it('keeps going after a failing undo', async () => {
    vi.useFakeTimers();
    undoable({ label: 'bad', undo: () => { throw new Error('gone'); }, redo: () => {} });
    await expect(undo()).resolves.toBeUndefined();
    vi.runAllTimers();
  });
});
